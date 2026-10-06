// Removable block devices: which ones may be mounted «como administrador» and which never. Shared by the mount helper
// (relay-manager-rootmount, as root: it DECIDES) and the service (Graph A, as relay-manager: it only lists them for the
// dialog). Only node: modules (the helper bundle must not pull anything from node_modules).
//
// Rules: the device path matches DEVICE_RE; its disk (a partition's parent) is removable or hangs from USB (USB hard
// disks say removable=0); never a disk any of whose partitions is mounted outside /media, /run/media or /mnt, is swap, or
// is used by LVM/RAID/dm-crypt (holders); a whole disk with partitions is refused (mount a partition). Loop devices only
// for the tests (one named loop device, through the unit's environment).
import fs from "node:fs"
import path from "node:path"
import { parseMountinfo, type MountEntry } from "@/server/files/copy/mounts"
import { within } from "@/server/files/copy/policy"

/** /dev/sdb1, /dev/sdc, /dev/mmcblk0p1, /dev/nvme0n1p1, /dev/loop7 (loop: tests only). Same as BLOCK_DEVICE_RE. */
export const DEVICE_RE = /^\/dev\/(sd[a-z]{1,2}\d{0,3}|mmcblk\d{1,2}(p\d{1,3})?|nvme\d{1,2}n\d{1,2}(p\d{1,3})?|loop\d{1,3}(p\d{1,3})?)$/
export const TEST_LOOP_RE = /^\/dev\/loop\d{1,3}$/
/** Mounts there do not make a disk «of the system» (removable media, manual mounts). */
export const MEDIA_MOUNT_PREFIXES: readonly string[] = ["/media", "/run/media", "/mnt"]

/** Filesystems the helper mounts. */
export const OWNERLESS_FS: ReadonlySet<string> = new Set(["vfat", "exfat", "ntfs", "ntfs3"])
// Not btrfs: a clone of a system btrfs (same fsid) can surface the system filesystem under /media on some kernels.
export const UNIX_FS: ReadonlySet<string> = new Set(["ext2", "ext3", "ext4", "xfs", "f2fs"])
export const READ_ONLY_FS: ReadonlySet<string> = new Set(["iso9660", "udf"])
export const isSupportedFs = (t: string | null) => !!t && (OWNERLESS_FS.has(t) || UNIX_FS.has(t) || READ_ONLY_FS.has(t))

export interface BlockDevice {
  /** "sdb1" */
  name: string
  /** "/dev/sdb1" */
  device: string
  /** "sdb" (itself for a whole disk). */
  diskName: string
  isPartition: boolean
  /** "8:17" */
  majorMinor: string
  /** The disk's removable flag. */
  removable: boolean
  /** The disk hangs from USB. */
  usb: boolean
  sizeBytes: number | null
  /** "Kingston DataTraveler" (vendor + model of the disk). */
  model: string | null
  holders: string[]
  /** Names of the partitions (whole disks only). */
  partitions: string[]
}

const readTrim = (p: string) => fs.promises.readFile(p, "utf8").then((s) => s.trim(), () => null)

/** One block device from sysfs (<sysRoot>/class/block/<name>), null when it does not exist. */
export async function readBlockDevice(sysRoot: string, name: string): Promise<BlockDevice | null> {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) return null
  let real: string
  try {
    real = await fs.promises.realpath(path.join(sysRoot, "class", "block", name))
  } catch {
    return null
  }
  const isPartition = (await readTrim(path.join(real, "partition"))) !== null
  const diskDir = isPartition ? path.dirname(real) : real
  const diskName = path.basename(diskDir)
  const majorMinor = (await readTrim(path.join(real, "dev"))) ?? ""
  const removable = (await readTrim(path.join(diskDir, "removable"))) === "1"
  const sectors = Number(await readTrim(path.join(real, "size")))
  const vendor = await readTrim(path.join(diskDir, "device", "vendor"))
  const modelRaw = await readTrim(path.join(diskDir, "device", "model"))
  const model = [vendor, modelRaw].filter((s): s is string => !!s).join(" ").replace(/\s+/g, " ").trim() || null
  const holders = await fs.promises.readdir(path.join(real, "holders")).catch(() => [] as string[])
  let partitions: string[] = []
  if (!isPartition) {
    const kids = await fs.promises.readdir(real).catch(() => [] as string[])
    for (const k of kids) {
      if (k.startsWith(name) && (await readTrim(path.join(real, k, "partition"))) !== null) partitions.push(k)
    }
    partitions = partitions.sort((a, b) => a.localeCompare(b, "en", { numeric: true }))
  }
  return {
    name, device: `/dev/${name}`, diskName, isPartition, majorMinor, removable, usb: /\/usb\d*\//.test(`${real}/`),
    sizeBytes: Number.isFinite(sectors) && sectors > 0 ? sectors * 512 : null, model, holders, partitions,
  }
}

/** Names under <sysRoot>/class/block worth looking at (no ram, zram, dm, md, sr; loop only the test one). */
export async function blockNames(sysRoot: string, testLoop: string | null): Promise<string[]> {
  const all = await fs.promises.readdir(path.join(sysRoot, "class", "block")).catch(() => [] as string[])
  const loop = testLoop ? path.basename(testLoop) : null
  return all.filter((n) => /^(sd[a-z]{1,2}\d{0,3}|mmcblk\d{1,2}(p\d{1,3})?|nvme\d{1,2}n\d{1,2}(p\d{1,3})?)$/.test(n) || (loop !== null && n === loop))
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }))
}

/** Device paths in use as swap (/proc/swaps). */
export function parseSwaps(text: string): string[] {
  return text.split("\n").slice(1).map((l) => l.trim().split(/\s+/)[0]).filter((s): s is string => !!s && s.startsWith("/"))
}

export interface DeviceContext {
  mounts: MountEntry[]
  /** Basenames of the swap devices. */
  swaps: string[]
  /** The disk and all its partitions. */
  family: BlockDevice[]
  /** Mounts below these do not make a disk «of the system» (default MEDIA_MOUNT_PREFIXES; tests: temporary folders). */
  mediaPrefixes?: readonly string[]
}

/** The mounts of one block device (by major:minor, so /dev names do not matter). */
export const mountsOf = (dev: BlockDevice, mounts: readonly MountEntry[]) => mounts.filter((m) => m.majorMinor === dev.majorMinor)

const isMediaMount = (mp: string, prefixes: readonly string[]) => prefixes.some((p) => within(mp, p) && mp !== p)

/**
 * Why this device must never be mounted, unmounted or listed as removable (Spanish), or null. `testLoop`: the one loop
 * device the tests use as a stand-in USB stick.
 */
export function deviceProblem(dev: BlockDevice, ctx: DeviceContext, testLoop: string | null): string | null {
  const isLoop = dev.diskName.startsWith("loop")
  if (isLoop && !(testLoop && (dev.device === testLoop || `/dev/${dev.diskName}` === testLoop))) return "Los dispositivos loop no se montan desde aquí."
  if (!isLoop && !dev.removable && !dev.usb) return `${dev.device} no es un dispositivo extraíble ni USB: no se monta desde aquí.`
  for (const d of ctx.family) {
    if (ctx.swaps.includes(d.name)) return `${dev.device} es parte de un disco del sistema (${d.device} es memoria de intercambio).`
    if (d.holders.length) return `${dev.device} es parte de un disco del sistema (${d.device} lo usa ${d.holders.join(", ")}: LVM, RAID o cifrado).`
    for (const m of mountsOf(d, ctx.mounts)) {
      if (!isMediaMount(m.mountPoint, ctx.mediaPrefixes ?? MEDIA_MOUNT_PREFIXES)) return `${dev.device} es parte de un disco del sistema (${d.device} está montado en ${m.mountPoint}).`
    }
  }
  return null
}

/** The disk and its partitions, read from sysfs. */
export async function familyOf(sysRoot: string, dev: BlockDevice): Promise<BlockDevice[]> {
  const disk = dev.isPartition ? await readBlockDevice(sysRoot, dev.diskName) : dev
  if (!disk) return [dev]
  const parts = await Promise.all(disk.partitions.map((p) => readBlockDevice(sysRoot, p)))
  return [disk, ...parts.filter((p): p is BlockDevice => p !== null)]
}

export interface ProbeEnv {
  sysRoot: string
  mountinfo(): Promise<string>
  swaps(): Promise<string>
  testLoop: string | null
  mediaPrefixes?: readonly string[]
}

export type CheckedDevice =
  | { ok: true; dev: BlockDevice; mounts: MountEntry[] }
  | { ok: false; code: "DEVICE" | "NOT_FOUND"; message: string }

/**
 * Full check of a device path given by a client: shape, sysfs, removable, not part of a system disk, not a whole disk
 * with partitions. `mounts` are this device's current mounts (the caller decides what «already mounted» means).
 */
export async function checkDevice(raw: string, env: ProbeEnv): Promise<CheckedDevice> {
  if (typeof raw !== "string" || !DEVICE_RE.test(raw)) return { ok: false, code: "DEVICE", message: "Dispositivo no válido." }
  const dev = await readBlockDevice(env.sysRoot, path.basename(raw))
  if (!dev || dev.device !== raw) return { ok: false, code: "NOT_FOUND", message: `No existe ${raw} (¿se ha quitado el pendrive?).` }
  const mounts = parseMountinfo(await env.mountinfo().catch(() => ""))
  const swaps = parseSwaps(await env.swaps().catch(() => "")).map((s) => path.basename(s))
  const family = await familyOf(env.sysRoot, dev)
  const why = deviceProblem(dev, { mounts, swaps, family, mediaPrefixes: env.mediaPrefixes }, env.testLoop)
  if (why) return { ok: false, code: "DEVICE", message: why }
  if (!dev.isPartition && dev.partitions.length) {
    return { ok: false, code: "DEVICE", message: `${dev.device} tiene particiones: monta una de ellas (${dev.partitions.map((p) => `/dev/${p}`).join(", ")}).` }
  }
  return { ok: true, dev, mounts: mountsOf(dev, mounts) }
}

/** What udev knows of a device (/run/udev/data/b<maj>:<min>): filesystem type, label and uuid. No root needed. */
export async function udevInfo(udevDataDir: string, majorMinor: string): Promise<{ fsType: string | null; label: string | null; uuid: string | null }> {
  const text = /^\d+:\d+$/.test(majorMinor) ? await fs.promises.readFile(path.join(udevDataDir, `b${majorMinor}`), "utf8").catch(() => "") : ""
  const env = new Map<string, string>()
  for (const line of text.split("\n")) {
    if (!line.startsWith("E:")) continue
    const i = line.indexOf("=")
    if (i > 2) env.set(line.slice(2, i), line.slice(i + 1))
  }
  const enc = env.get("ID_FS_LABEL_ENC")
  const label = enc ? enc.replace(/\\x([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))) : env.get("ID_FS_LABEL") ?? null
  return { fsType: env.get("ID_FS_TYPE") || null, label: label || null, uuid: env.get("ID_FS_UUID") || null }
}

/** "/dev/disk/by-<kind>/<name>" → device basename → name (udev escapes as \x20). */
export async function linksByDevice(devRoot: string, kind: "by-label" | "by-uuid"): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const dir = path.join(devRoot, "disk", kind)
  for (const n of await fs.promises.readdir(dir).catch(() => [] as string[])) {
    const target = await fs.promises.readlink(path.join(dir, n)).catch(() => null)
    if (target) out.set(path.basename(target), n.replace(/\\x([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))))
  }
  return out
}

/**
 * The mount folder name for a label (or uuid, or the device name): [A-Za-z0-9._-] only (anything else "_"), no leading
 * dots, at most 64 characters; never "" "." "..".
 */
export function mountDirName(label: string | null, uuid: string | null, deviceName: string): string {
  for (const cand of [label, uuid, deviceName]) {
    if (!cand) continue
    const s = cand.normalize("NFD").replace(/\p{M}/gu, "").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._]+/, "").replace(/_+$/, "").slice(0, 64)
    if (s && s !== "." && s !== "..") return s
  }
  return "pendrive"
}

/** Mount options for a filesystem type: always nosuid,nodev,noexec; FAT/exFAT/NTFS owned by the sudo user + relay-files. */
export function mountOptions(fsType: string, ids: { uid: number; gid: number }): string {
  const base = ["nosuid", "nodev", "noexec"]
  if (READ_ONLY_FS.has(fsType)) return ["ro", ...base].join(",")
  if (OWNERLESS_FS.has(fsType)) {
    const o = [...base, `uid=${ids.uid}`, `gid=${ids.gid}`, "umask=0002", "dmask=0002", "fmask=0113"]
    if (fsType === "vfat") o.push("utf8", "shortname=mixed")
    return o.join(",")
  }
  return base.join(",")
}
