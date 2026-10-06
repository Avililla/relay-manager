// «Copiar a una carpeta del servidor»: the drives the dialog offers first («Unidades USB y discos»). Mounted ones from
// /proc/self/mountinfo (the mounts this process sees, its own sandbox included) and sysfs (/sys/dev/block/<maj:min>:
// removable flag and whether the disk hangs from USB), with the label from /dev/disk/by-label when udev made it; and the
// removable devices that are NOT mounted (sysfs + the udev database), which the mount helper can mount. Read-only:
// nothing is mounted or unmounted here (the mount helper decides again whether a device may be mounted).
import fs from "node:fs"
import path from "node:path"
import type { CopyDeviceDTO, CopyDriveDTO } from "@/lib/contracts/files"
import { blockNames, deviceProblem, familyOf, isSupportedFs, linksByDevice, mountsOf, parseSwaps, readBlockDevice, udevInfo } from "@/server/rootmount/devices"
import { within } from "./policy"

export interface MountEntry {
  id: number
  parentId: number
  /** "8:17" */
  majorMinor: string
  /** The root of the mount within its filesystem ("/" for a whole filesystem; a subfolder for a bind mount). */
  root: string
  mountPoint: string
  options: string[]
  fsType: string
  source: string
  superOptions: string[]
}

/** Folders under which mounts are offered whatever their device (desktop automount, manual mounts). */
export const MEDIA_PREFIXES: readonly string[] = ["/media", "/run/media", "/mnt"]

const PSEUDO = new Set([
  "proc", "sysfs", "tmpfs", "devtmpfs", "devpts", "cgroup", "cgroup2", "securityfs", "pstore", "bpf", "tracefs", "debugfs",
  "configfs", "fusectl", "mqueue", "hugetlbfs", "binfmt_misc", "efivarfs", "autofs", "rpc_pipefs", "nsfs", "ramfs",
  "nfsd", "fuse.gvfsd-fuse", "fuse.portal", "fuse.snapfuse", "squashfs", "overlay", "selinuxfs", "tmpfs.none",
])
/** Never offered as a drive even when the device is removable. */
const SKIP_UNDER = ["/proc", "/sys", "/dev", "/boot", "/snap", "/var/lib/docker", "/var/lib/containers", "/var/snap"]

/** mountinfo escapes space, tab, newline and backslash as \040, \011, \012 and \134. */
export function unescapeMount(s: string): string {
  return s.replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8)))
}

/** Parses /proc/<pid>/mountinfo (proc(5)); malformed lines are skipped. */
export function parseMountinfo(text: string): MountEntry[] {
  const out: MountEntry[] = []
  for (const line of text.split("\n")) {
    if (!line.trim()) continue
    const sep = line.indexOf(" - ")
    if (sep < 0) continue
    const left = line.slice(0, sep).split(" ")
    const right = line.slice(sep + 3).split(" ")
    if (left.length < 6 || right.length < 3) continue
    const id = Number(left[0])
    const parentId = Number(left[1])
    if (!Number.isInteger(id) || !Number.isInteger(parentId)) continue
    out.push({
      id, parentId, majorMinor: left[2], root: unescapeMount(left[3]), mountPoint: unescapeMount(left[4]),
      options: left[5].split(","), fsType: right[0], source: unescapeMount(right[1]), superOptions: right.slice(2).join(" ").split(","),
    })
  }
  return out
}

export const isReadOnly = (m: MountEntry) => m.options.includes("ro") || m.superOptions.includes("ro")

/** The mount that holds `real` (the deepest mount point; the last one when stacked). */
export function mountFor(real: string, mounts: readonly MountEntry[]): MountEntry | null {
  let best: MountEntry | null = null
  for (const m of mounts) {
    if (!within(real, m.mountPoint)) continue
    if (!best || m.mountPoint.length >= best.mountPoint.length) best = m
  }
  return best
}

/**
 * The other names of `real` on the same filesystem, through the mounts of this namespace: a bind mount of /etc on
 * /mnt/x makes /mnt/x/passwd also /etc/passwd. For each mount of the same device whose subtree holds the path, the
 * path seen from that mount. Lets the deny-list apply to what a folder really is, not only to how it is reached.
 */
export function aliasesOf(real: string, mounts: readonly MountEntry[]): string[] {
  const m = mountFor(real, mounts)
  if (!m) return []
  const rel = real === m.mountPoint ? "" : real.slice(m.mountPoint === "/" ? 0 : m.mountPoint.length)
  const inFs = m.root === "/" ? rel || "/" : `${m.root}${rel}`
  const out = new Set<string>()
  for (const n of mounts) {
    if (n.majorMinor !== m.majorMinor || !within(inFs, n.root)) continue
    const rest = n.root === "/" ? inFs : inFs.slice(n.root.length)
    const alias = n.mountPoint === "/" ? rest || "/" : `${n.mountPoint}${rest === "/" ? "" : rest}`
    if (alias !== real) out.add(alias)
  }
  return [...out]
}

export interface BlockInfo { removable: boolean; usb: boolean; device: string }

/**
 * The block device of a mount (by its major:minor, so it works without /dev names): removable flag of the disk (the
 * partition's parent) and whether it hangs from USB (USB hard disks say removable=0). null for non-block mounts.
 */
export async function blockInfo(majorMinor: string, sysRoot: string): Promise<BlockInfo | null> {
  if (!/^\d+:\d+$/.test(majorMinor) || majorMinor.startsWith("0:")) return null
  let real: string
  try {
    real = await fs.promises.realpath(path.join(sysRoot, "dev", "block", majorMinor))
  } catch {
    return null
  }
  const isPartition = await fs.promises.access(path.join(real, "partition")).then(() => true, () => false)
  const disk = isPartition ? path.dirname(real) : real
  const removable = (await fs.promises.readFile(path.join(disk, "removable"), "utf8").catch(() => "0")).trim() === "1"
  return { removable, usb: /\/usb\d*\//.test(`${real}/`), device: `/dev/${path.basename(real)}` }
}

/** Labels of the block devices: /dev/disk/by-label/<label> → "/dev/sdb1" (udev escapes as \x20). */
export async function labelsByDevice(devRoot: string): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const dir = path.join(devRoot, "disk", "by-label")
  let names: string[]
  try {
    names = await fs.promises.readdir(dir)
  } catch {
    return out
  }
  for (const n of names) {
    const target = await fs.promises.readlink(path.join(dir, n)).catch(() => null)
    if (!target) continue
    const dev = `/dev/${path.basename(target)}`
    out.set(dev, n.replace(/\\x([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))))
  }
  return out
}

export interface DrivesDeps {
  mountinfo(): Promise<string>
  sysRoot: string
  devRoot: string
  /** /run/udev/data (filesystem type and label of unmounted devices). */
  udevDataDir?: string
  /** /proc/swaps */
  swaps?(): Promise<string>
  /** TESTS ONLY (RM_COPY_TEST_REMOVABLE): this /dev/loopN is listed as a USB stick. */
  testLoop?: string | null
  statfs(p: string): Promise<{ freeBytes: number; totalBytes: number } | null>
  /** "rw": the service can write; "r": only read; null: cannot even open it. */
  access(p: string): Promise<"rw" | "r" | null>
}

/**
 * The drives worth offering: mounts below /media, /run/media or /mnt (not those folders themselves, which the service
 * sandbox bind-mounts), and any other mount of a removable or USB block device. Pseudo filesystems, system folders and
 * bind mounts of a subfolder are left out; a mount point mounted twice shows once (the top one).
 */
export async function listDrives(deps: DrivesDeps): Promise<CopyDriveDTO[]> {
  let mounts: MountEntry[]
  try {
    mounts = parseMountinfo(await deps.mountinfo())
  } catch {
    return []
  }
  const labels = await labelsByDevice(deps.devRoot)
  const byPoint = new Map<string, CopyDriveDTO>()
  for (const m of mounts) {
    if (PSEUDO.has(m.fsType) || m.mountPoint === "/") continue
    if (SKIP_UNDER.some((s) => within(m.mountPoint, s))) continue
    if (within(m.mountPoint, "/run") && !within(m.mountPoint, "/run/media")) continue
    const underMedia = MEDIA_PREFIXES.some((p) => within(m.mountPoint, p) && m.mountPoint !== p)
    const block = await blockInfo(m.majorMinor, deps.sysRoot)
    const isTestLoop = !!block && !!deps.testLoop && (block.device === deps.testLoop || block.device.startsWith(`${deps.testLoop}p`))
    const removable = !!block && (block.removable || block.usb || isTestLoop)
    if (!underMedia && !removable) continue
    if (!underMedia && m.root !== "/") continue // a bind mount of a subfolder of an internal disk
    const device = block?.device ?? (m.source.startsWith("/dev/") ? m.source : "")
    const label = labels.get(device) ?? (m.source.startsWith("/dev/") ? labels.get(m.source) : undefined) ?? path.basename(m.mountPoint)
    const space = await deps.statfs(m.mountPoint)
    const acc = await deps.access(m.mountPoint)
    const readOnly = isReadOnly(m)
    const ejectable = removable && ["/media", "/run/media"].some((p) => within(m.mountPoint, p) && m.mountPoint !== p)
    byPoint.set(m.mountPoint, {
      mountPoint: m.mountPoint, label, fsType: m.fsType, device, removable, readOnly,
      freeBytes: space?.freeBytes ?? null, totalBytes: space?.totalBytes ?? null,
      writable: acc === "rw" && !readOnly, readable: acc !== null, ejectable,
    })
  }
  return [...byPoint.values()].sort((a, b) => Number(b.removable) - Number(a.removable) || a.mountPoint.localeCompare(b.mountPoint, "es", { numeric: true }))
}

/**
 * Removable devices (USB sticks, SD cards) that are not mounted: the partitions of a removable or USB disk (or the disk
 * itself when it has no partition table), never part of a system disk (devices.ts), never empty card-reader slots.
 * Advisory: the mount helper checks everything again as root.
 */
export async function listUnmountedDevices(deps: DrivesDeps): Promise<CopyDeviceDTO[]> {
  const testLoop = deps.testLoop ?? null
  let mountsText = ""
  try {
    mountsText = await deps.mountinfo()
  } catch {
    return []
  }
  const mounts = parseMountinfo(mountsText)
  const swaps = parseSwaps(deps.swaps ? await deps.swaps().catch(() => "") : "").map((s) => path.basename(s))
  const labels = await linksByDevice(deps.devRoot, "by-label")
  const uuids = await linksByDevice(deps.devRoot, "by-uuid")
  const out: CopyDeviceDTO[] = []
  for (const name of await blockNames(deps.sysRoot, testLoop)) {
    const dev = await readBlockDevice(deps.sysRoot, name)
    if (!dev || !dev.sizeBytes) continue
    if (!dev.isPartition && dev.partitions.length) continue // its partitions are listed instead
    if (mountsOf(dev, mounts).length) continue // mounted: it is a drive already
    const family = await familyOf(deps.sysRoot, dev)
    if (deviceProblem(dev, { mounts, swaps, family }, testLoop)) continue // internal or system disks are not offered
    const u = await udevInfo(deps.udevDataDir ?? "/run/udev/data", dev.majorMinor)
    const disk = family[0]
    const fsType = u.fsType
    out.push({
      device: dev.device, disk: `/dev/${dev.diskName}`, label: u.label ?? labels.get(name) ?? null, uuid: u.uuid ?? uuids.get(name) ?? null,
      fsType, sizeBytes: dev.sizeBytes, model: disk?.model ?? dev.model, usb: dev.usb,
      problem: fsType && !isSupportedFs(fsType)
        ? fsType === "swap" || fsType.endsWith("_member") || fsType === "crypto_LUKS"
          ? `No es un sistema de ficheros que se pueda abrir (${fsType}).`
          : `Sistema de ficheros no admitido (${fsType}).`
        : null,
    })
  }
  return out
}

/** The real implementation of DrivesDeps for this process. */
export function systemDrivesDeps(sysRoot = "/sys", devRoot = "/dev", testLoop: string | null = null): DrivesDeps {
  return {
    mountinfo: () => fs.promises.readFile("/proc/self/mountinfo", "utf8"),
    swaps: () => fs.promises.readFile("/proc/swaps", "utf8"),
    udevDataDir: "/run/udev/data",
    testLoop,
    sysRoot,
    devRoot,
    async statfs(p) {
      try {
        const s = await fs.promises.statfs(p)
        return { freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize }
      } catch {
        return null
      }
    },
    async access(p) {
      try {
        await fs.promises.access(p, fs.constants.R_OK | fs.constants.X_OK)
      } catch {
        return null
      }
      return fs.promises.access(p, fs.constants.W_OK).then(() => "rw" as const, () => "r" as const)
    },
  }
}
