// A fake /sys for block devices (class/block, dev/block, removable, partition, holders, size, vendor/model), shaped like
// the kernel's: the class links point into devices/…/block/<disk>[/<partition>], a USB disk hangs from …/usb1/….
import fs from "node:fs"
import path from "node:path"
import { createRootMountServer, type MountExec } from "@/server/rootmount/server"

export interface FakeDisk {
  name: string
  /** "8:16" */
  dev: string
  usb?: boolean
  removable?: boolean
  sizeSectors?: number
  vendor?: string
  model?: string
  holders?: string[]
  partitions?: Array<{ name: string; dev: string; sizeSectors?: number; holders?: string[] }>
}

export function makeFakeSysfs(root: string, disks: readonly FakeDisk[]): string {
  for (const d of disks) {
    const base = path.join(root, "devices", "pci0000:00", d.usb ? "usb1/1-1/1-1:1.0/host6/target6:0:0/6:0:0:0" : "ata1/host0/target0:0:0/0:0:0:0", "block")
    const diskDir = path.join(base, d.name)
    fs.mkdirSync(path.join(diskDir, "holders"), { recursive: true })
    fs.writeFileSync(path.join(diskDir, "dev"), `${d.dev}\n`)
    fs.writeFileSync(path.join(diskDir, "removable"), d.removable ? "1\n" : "0\n")
    fs.writeFileSync(path.join(diskDir, "size"), `${d.sizeSectors ?? 15_000_000}\n`)
    fs.mkdirSync(path.join(diskDir, "device"), { recursive: true })
    if (d.vendor) fs.writeFileSync(path.join(diskDir, "device", "vendor"), `${d.vendor}  \n`)
    if (d.model) fs.writeFileSync(path.join(diskDir, "device", "model"), `${d.model}\n`)
    for (const h of d.holders ?? []) fs.mkdirSync(path.join(diskDir, "holders", h))
    link(root, d.name, d.dev, diskDir)
    for (const p of d.partitions ?? []) {
      const pd = path.join(diskDir, p.name)
      fs.mkdirSync(path.join(pd, "holders"), { recursive: true })
      fs.writeFileSync(path.join(pd, "partition"), "1\n")
      fs.writeFileSync(path.join(pd, "dev"), `${p.dev}\n`)
      fs.writeFileSync(path.join(pd, "size"), `${p.sizeSectors ?? 15_000_000}\n`)
      for (const h of p.holders ?? []) fs.mkdirSync(path.join(pd, "holders", h))
      link(root, p.name, p.dev, pd)
    }
  }
  return root
}

function link(root: string, name: string, dev: string, target: string): void {
  fs.mkdirSync(path.join(root, "class", "block"), { recursive: true })
  fs.mkdirSync(path.join(root, "dev", "block"), { recursive: true })
  fs.symlinkSync(target, path.join(root, "class", "block", name))
  fs.symlinkSync(target, path.join(root, "dev", "block", dev))
}

/** A mountinfo line for a block device mount (proc(5)). */
export function mountLine(id: number, dev: string, mountPoint: string, fsType: string, source: string, opts = "rw,relatime"): string {
  return `${id} 1 ${dev} / ${mountPoint.replace(/ /g, "\\040")} ${opts} shared:${id} - ${fsType} ${source} rw`
}

const UID = process.getuid?.() ?? 1000

export interface FakeHost {
  tmp: string
  sys: string
  media: string
  mounts: string[]
  swaps: string[]
  blkid: Record<string, Record<string, string>>
  calls: Array<{ op: string; args: unknown }>
  failMount: Set<string>
  busy: Set<string>
  exec: MountExec
}

/** A fake bench host for the mount helper. A bench with: sda (internal, system), sdb (USB stick, 2 partitions), sdc (removable, no partitions), sdd (USB disk
 * holding the root filesystem on sdd2), sde (USB with swap), sdf (USB with LVM), loop7 (test stand-in). */
export function fakeHost(tmp: string): FakeHost {
  const sys = makeFakeSysfs(path.join(tmp, "sys"), [
    { name: "sda", dev: "8:0", partitions: [{ name: "sda1", dev: "8:1" }, { name: "sda2", dev: "8:2" }] },
    { name: "sdb", dev: "8:16", usb: true, removable: true, vendor: "Kingston", model: "DataTraveler 3.0", partitions: [{ name: "sdb1", dev: "8:17" }, { name: "sdb2", dev: "8:18" }] },
    { name: "sdc", dev: "8:32", removable: true, model: "SD Card Reader" },
    { name: "sdd", dev: "8:48", usb: true, partitions: [{ name: "sdd1", dev: "8:49" }, { name: "sdd2", dev: "8:50" }] },
    { name: "sde", dev: "8:64", usb: true, partitions: [{ name: "sde1", dev: "8:65" }, { name: "sde2", dev: "8:66" }] },
    { name: "sdf", dev: "8:80", usb: true, partitions: [{ name: "sdf1", dev: "8:81", holders: ["dm-0"] }] },
    { name: "loop7", dev: "7:7" },
  ])
  const media = path.join(tmp, "media")
  fs.mkdirSync(media, { mode: 0o755 })
  fs.chmodSync(media, 0o755)
  const host: FakeHost = {
    tmp, sys, media,
    mounts: [mountLine(22, "8:2", "/", "ext4", "/dev/sda2"), mountLine(23, "8:1", "/boot/efi", "vfat", "/dev/sda1"), mountLine(24, "8:50", "/srv/raiz-usb", "ext4", "/dev/sdd2")],
    swaps: ["/dev/sde2"],
    blkid: {
      "/dev/sdb1": { TYPE: "vfat", LABEL: "MI USB", UUID: "1234-ABCD" },
      "/dev/sdb2": { TYPE: "ext4", UUID: "0f0e-uuid" },
      "/dev/sdc": { TYPE: "exfat", LABEL: "CAMARA" },
      "/dev/sdd1": { TYPE: "vfat", LABEL: "X" },
      "/dev/sde1": { TYPE: "ntfs", LABEL: "Windows" },
      "/dev/loop7": { TYPE: "vfat", LABEL: "PRUEBA" },
    },
    calls: [], failMount: new Set(), busy: new Set(),
    exec: null as unknown as MountExec,
  }
  let nextId = 100
  host.exec = {
    async blkid(device) {
      host.calls.push({ op: "blkid", args: device })
      return host.blkid[device] ?? {}
    },
    async mount(a) {
      host.calls.push({ op: "mount", args: a })
      if (host.failMount.has(a.device)) throw new Error("mount: wrong fs type, bad option, bad superblock")
      const dev = fs.readFileSync(path.join(sys, "class", "block", path.basename(a.device), "dev"), "utf8").trim()
      host.mounts.push(mountLine(nextId++, dev, a.dir, a.type, a.device, `rw,${a.options}`))
    },
    async umount(dir) {
      host.calls.push({ op: "umount", args: dir })
      if (host.busy.has(dir)) throw new Error(`umount: ${dir}: target is busy.`)
      host.mounts = host.mounts.filter((l) => l.split(" ")[4] !== dir.replace(/ /g, "\\040"))
    },
    async sync(dir) {
      host.calls.push({ op: "sync", args: dir })
    },
    async allowGroup(dir, group) {
      host.calls.push({ op: "setfacl", args: [dir, group] })
    },
    async isBlockDevice() {
      return true
    },
  }
  fs.writeFileSync(path.join(tmp, "passwd"), "root:x:0:0::/root:/bin/bash\nana:x:1000:1000::/home/ana:/bin/bash\n")
  fs.writeFileSync(path.join(tmp, "group"), "sudo:x:27:ana\nrelay-files:x:995:ana,relay-manager\n")
  return host
}

export function startMountHelper(host: FakeHost, sock: string, over: { testLoop?: string | null; enabled?: boolean; sudoUser?: string } = {}) {
  const server = createRootMountServer({
    config: { enabled: over.enabled ?? true, sudoUser: over.sudoUser ?? "ana", filesGroup: "relay-files" },
    exec: host.exec, version: "test", sysRoot: host.sys, mediaRoot: host.media, runMediaRoot: path.join(host.tmp, "run-media"),
    mountinfo: async () => host.mounts.join("\n"), swaps: async () => `Filename Type Size Used Priority\n${host.swaps.map((s) => `${s} partition 1 0 -2`).join("\n")}\n`,
    passwdFile: path.join(host.tmp, "passwd"), groupFile: path.join(host.tmp, "group"), stateDir: path.join(host.tmp, "state"),
    testLoop: over.testLoop ?? null, rootUid: UID,
  })
  fs.mkdirSync(path.join(host.tmp, "state"), { recursive: true })
  return new Promise<typeof server>((r) => server.listen(sock, () => r(server)))
}

