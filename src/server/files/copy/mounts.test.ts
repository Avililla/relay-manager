import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { makeFakeSysfs, mountLine } from "../../../../test/helpers/fake-sysfs"
import { aliasesOf, blockInfo, isReadOnly, labelsByDevice, listDrives, listUnmountedDevices, mountFor, parseMountinfo, unescapeMount, type DrivesDeps } from "./mounts"

// Lines as the kernel writes them (proc(5)); a desktop automount with a space in the label, a manual mount, the
// service sandbox's bind mounts (/media itself, a home folder) and pseudo filesystems.
const MOUNTINFO = [
  "22 1 8:2 / / rw,relatime shared:1 - ext4 /dev/sda2 rw,errors=remount-ro",
  "23 22 0:21 / /proc rw,nosuid,nodev,noexec,relatime shared:12 - proc proc rw",
  "24 22 0:22 / /sys rw,nosuid,nodev,noexec,relatime shared:2 - sysfs sysfs rw",
  "25 22 0:25 / /run rw,nosuid,nodev,noexec,relatime shared:5 - tmpfs tmpfs rw,size=1600000k,mode=755",
  "60 22 8:2 /media /media rw,relatime shared:1 - ext4 /dev/sda2 rw,errors=remount-ro",
  "61 22 8:2 /home/ana/tftp /home/ana/tftp rw,relatime shared:1 - ext4 /dev/sda2 rw",
  "90 60 8:17 / /media/ana/USB\\040DISK rw,nosuid,nodev,relatime shared:80 - vfat /dev/sdb1 rw,uid=1000,gid=1000,fmask=0022,dmask=0022,codepage=437",
  "91 22 8:33 / /mnt/copias ro,relatime shared:81 - ext4 /dev/sdc1 ro",
  "92 25 0:50 / /run/user/1000 rw,nosuid,nodev,relatime shared:90 - tmpfs tmpfs rw,size=300000k,mode=700,uid=1000",
  "93 22 8:49 / /srv/externo rw,relatime shared:82 - exfat /dev/sdd1 rw",
  "94 22 259:3 / /data rw,relatime shared:83 - ext4 /dev/nvme0n1p3 rw",
  "95 22 7:1 / /snap/core/1 ro,nodev,relatime shared:84 - squashfs /dev/loop1 ro",
  "96 25 0:60 / /run/media/ana/CAM rw,relatime shared:85 - fuseblk /dev/sde1 rw,user_id=0",
  "not a mountinfo line",
].join("\n")

describe("mountinfo", () => {
  it("unescapes \\040, \\011, \\012 and \\134", () => {
    expect(unescapeMount("USB\\040DISK\\011x\\012y\\134z")).toBe("USB DISK\tx\ny\\z")
  })
  it("parses fields, skipping malformed lines", () => {
    const m = parseMountinfo(MOUNTINFO)
    expect(m).toHaveLength(13)
    const usb = m.find((x) => x.id === 90)
    expect(usb).toMatchObject({ parentId: 60, majorMinor: "8:17", root: "/", mountPoint: "/media/ana/USB DISK", fsType: "vfat", source: "/dev/sdb1" })
    expect(usb?.superOptions).toContain("uid=1000")
    expect(isReadOnly(m.find((x) => x.id === 91)!)).toBe(true)
    expect(isReadOnly(usb!)).toBe(false)
  })
  it("finds the deepest mount of a path", () => {
    const m = parseMountinfo(MOUNTINFO)
    expect(mountFor("/media/ana/USB DISK/fotos", m)?.id).toBe(90)
    expect(mountFor("/media/ana", m)?.id).toBe(60)
    expect(mountFor("/etc", m)?.id).toBe(22)
  })
})

describe("block devices in sysfs and labels", () => {
  let root: string
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "rm-sysfs-"))
    const mk = (rel: string, files: Record<string, string> = {}) => {
      fs.mkdirSync(path.join(root, rel), { recursive: true })
      for (const [k, v] of Object.entries(files)) fs.writeFileSync(path.join(root, rel, k), v)
    }
    // A USB stick (removable=1), a USB hard disk (removable=0 but on USB), an internal NVMe and an internal SATA disk.
    mk("devices/pci0000:00/0000:00:14.0/usb2/2-1/2-1:1.0/host6/target6:0:0/6:0:0:0/block/sdb", { removable: "1\n" })
    mk("devices/pci0000:00/0000:00:14.0/usb2/2-1/2-1:1.0/host6/target6:0:0/6:0:0:0/block/sdb/sdb1", { partition: "1\n" })
    mk("devices/pci0000:00/0000:00:14.0/usb3/3-2/3-2:1.0/host7/target7:0:0/7:0:0:0/block/sdd", { removable: "0\n" })
    mk("devices/pci0000:00/0000:00:14.0/usb3/3-2/3-2:1.0/host7/target7:0:0/7:0:0:0/block/sdd/sdd1", { partition: "1\n" })
    mk("devices/pci0000:00/0000:00:1d.0/nvme/nvme0/nvme0n1", { removable: "0\n" })
    mk("devices/pci0000:00/0000:00:1d.0/nvme/nvme0/nvme0n1/nvme0n1p3", { partition: "3\n" })
    mk("devices/pci0000:00/0000:00:17.0/ata1/host0/target0:0:0/0:0:0:0/block/sdc", { removable: "0\n" })
    mk("devices/pci0000:00/0000:00:17.0/ata1/host0/target0:0:0/0:0:0:0/block/sdc/sdc1", { partition: "1\n" })
    mk("dev/block")
    const link = (mm: string, target: string) => fs.symlinkSync(path.join(root, target), path.join(root, "dev/block", mm))
    link("8:17", "devices/pci0000:00/0000:00:14.0/usb2/2-1/2-1:1.0/host6/target6:0:0/6:0:0:0/block/sdb/sdb1")
    link("8:49", "devices/pci0000:00/0000:00:14.0/usb3/3-2/3-2:1.0/host7/target7:0:0/7:0:0:0/block/sdd/sdd1")
    link("259:3", "devices/pci0000:00/0000:00:1d.0/nvme/nvme0/nvme0n1/nvme0n1p3")
    link("8:33", "devices/pci0000:00/0000:00:17.0/ata1/host0/target0:0:0/0:0:0:0/block/sdc/sdc1")
    // udev's labels (escaped as \x20)
    mk("devroot/disk/by-label")
    fs.symlinkSync("../../sdb1", path.join(root, "devroot/disk/by-label/USB\\x20DISK"))
    fs.symlinkSync("../../sdd1", path.join(root, "devroot/disk/by-label/EXTERNO"))
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  it("removable flag of the parent disk, USB parentage, device name", async () => {
    expect(await blockInfo("8:17", root)).toEqual({ removable: true, usb: true, device: "/dev/sdb1" })
    expect(await blockInfo("8:49", root)).toEqual({ removable: false, usb: true, device: "/dev/sdd1" })
    expect(await blockInfo("259:3", root)).toEqual({ removable: false, usb: false, device: "/dev/nvme0n1p3" })
    expect(await blockInfo("0:21", root)).toBeNull()
    expect(await blockInfo("9:9", root)).toBeNull()
    expect(await blockInfo("../x", root)).toBeNull()
  })

  it("labels by device, unescaped", async () => {
    const l = await labelsByDevice(path.join(root, "devroot"))
    expect(l.get("/dev/sdb1")).toBe("USB DISK")
    expect(l.get("/dev/sdd1")).toBe("EXTERNO")
    expect((await labelsByDevice(path.join(root, "nada"))).size).toBe(0)
  })

  it("lists media mounts and removable/USB disks, not the sandbox, internal disks or pseudo filesystems", async () => {
    const deps: DrivesDeps = {
      mountinfo: async () => MOUNTINFO,
      sysRoot: root,
      devRoot: path.join(root, "devroot"),
      statfs: async (p) => (p === "/media/ana/USB DISK" ? { freeBytes: 3e9, totalBytes: 8e9 } : null),
      access: async (p) => (p === "/media/ana/USB DISK" ? null : p === "/mnt/copias" ? "r" : "rw"),
    }
    const drives = await listDrives(deps)
    // Removable first, then by path.
    expect(drives.map((d) => d.mountPoint)).toEqual(["/media/ana/USB DISK", "/srv/externo", "/mnt/copias", "/run/media/ana/CAM"])
    const usb = drives[0]
    expect(usb).toMatchObject({ label: "USB DISK", fsType: "vfat", device: "/dev/sdb1", removable: true, readOnly: false, freeBytes: 3e9, totalBytes: 8e9, writable: false, readable: false })
    expect(drives.find((d) => d.mountPoint === "/srv/externo")).toMatchObject({ label: "EXTERNO", removable: true, writable: true })
    expect(drives.find((d) => d.mountPoint === "/mnt/copias")).toMatchObject({ readOnly: true, writable: false, readable: true, removable: false })
    expect(drives.find((d) => d.mountPoint === "/run/media/ana/CAM")).toMatchObject({ label: "CAM" })
    // «Expulsar»: removable or USB, mounted under /media or /run/media.
    expect(drives.filter((d) => d.ejectable).map((d) => d.mountPoint)).toEqual(["/media/ana/USB DISK"])
  })

  it("an unreadable mountinfo gives no drives", async () => {
    const deps: DrivesDeps = { mountinfo: async () => { throw new Error("EACCES") }, sysRoot: root, devRoot: root, statfs: async () => null, access: async () => null }
    expect(await listDrives(deps)).toEqual([])
  })
})

describe("aliasesOf: the same folder under another mount", () => {
  const mi = [
    "22 1 8:2 / / rw - ext4 /dev/sda2 rw",
    "30 22 8:2 /etc /mnt/etc-bind rw - ext4 /dev/sda2 rw",
    "31 22 8:2 /media /media rw - ext4 /dev/sda2 rw",
    "32 22 8:3 / /usr rw - ext4 /dev/sda3 rw",
    "33 22 8:3 /lib /mnt/usrlib rw - ext4 /dev/sda3 rw",
    "90 31 8:17 / /media/ana/USB rw - vfat /dev/sdb1 rw",
  ].join("\n")
  const m = parseMountinfo(mi)
  it("a bind mount of a system folder is seen through its original place", () => {
    expect(aliasesOf("/mnt/etc-bind/ssh", m)).toContain("/etc/ssh")
    expect(aliasesOf("/mnt/etc-bind", m)).toContain("/etc")
    expect(aliasesOf("/mnt/usrlib/x", m)).toContain("/usr/lib/x")
  })
  it("ordinary folders and removable media have no system alias", () => {
    expect(aliasesOf("/media/ana/USB/fotos", m)).toEqual([])
    expect(aliasesOf("/srv/x", m)).toEqual([])
    expect(aliasesOf("/media/ana", m)).toEqual([])
  })
})

describe("unmounted removable devices («Montar»)", () => {
  let root: string
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "rm-devs-"))
    makeFakeSysfs(path.join(root, "sys"), [
      { name: "sda", dev: "8:0", partitions: [{ name: "sda1", dev: "8:1" }, { name: "sda2", dev: "8:2" }] },
      { name: "sdb", dev: "8:16", usb: true, removable: true, vendor: "Kingston", model: "DataTraveler 3.0", partitions: [{ name: "sdb1", dev: "8:17" }, { name: "sdb2", dev: "8:18" }] },
      { name: "sdc", dev: "8:32", removable: true, model: "Card Reader" },
      { name: "sdg", dev: "8:96", removable: true, sizeSectors: 0 },
      { name: "sdd", dev: "8:48", usb: true, partitions: [{ name: "sdd1", dev: "8:49" }, { name: "sdd2", dev: "8:50" }] },
      { name: "loop3", dev: "7:3" },
    ])
    fs.mkdirSync(path.join(root, "udev"))
    fs.writeFileSync(path.join(root, "udev", "b8:18"), "S:disk/by-label/DATOS\nE:ID_FS_TYPE=ext4\nE:ID_FS_LABEL=DATOS\nE:ID_FS_LABEL_ENC=DATOS\\x20USB\nE:ID_FS_UUID=abcd\n")
    fs.writeFileSync(path.join(root, "udev", "b8:32"), "E:ID_FS_TYPE=crypto_LUKS\n")
    fs.mkdirSync(path.join(root, "dev", "disk", "by-uuid"), { recursive: true })
    fs.symlinkSync("../../loop3", path.join(root, "dev", "disk", "by-uuid", "77AA-1B2C"))
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))
  const deps = (over: Partial<DrivesDeps> = {}): DrivesDeps => ({
    mountinfo: async () => [mountLine(22, "8:2", "/", "ext4", "/dev/sda2"), mountLine(30, "8:17", "/media/ana/USB", "vfat", "/dev/sdb1"), mountLine(31, "8:50", "/home", "ext4", "/dev/sdd2")].join("\n"),
    swaps: async () => "Filename Type\n",
    sysRoot: path.join(root, "sys"), devRoot: path.join(root, "dev"), udevDataDir: path.join(root, "udev"),
    statfs: async () => null, access: async () => "rw", ...over,
  })

  it("partitions of removable/USB disks that are not mounted; never internal or system disks, nor empty slots", async () => {
    const list = await listUnmountedDevices(deps())
    expect(list.map((d) => d.device)).toEqual(["/dev/sdb2", "/dev/sdc"])
    expect(list[0]).toEqual({
      device: "/dev/sdb2", disk: "/dev/sdb", label: "DATOS USB", uuid: "abcd", fsType: "ext4", sizeBytes: 15_000_000 * 512,
      model: "Kingston DataTraveler 3.0", usb: true, problem: null,
    })
    expect(list[1]).toMatchObject({ device: "/dev/sdc", fsType: "crypto_LUKS", problem: expect.stringMatching(/crypto_LUKS/), usb: false })
  })

  it("the test loop device (RM_COPY_TEST_REMOVABLE) is listed, with its uuid from /dev/disk/by-uuid", async () => {
    expect((await listUnmountedDevices(deps())).some((d) => d.device === "/dev/loop3")).toBe(false)
    const list = await listUnmountedDevices(deps({ testLoop: "/dev/loop3" }))
    expect(list.find((d) => d.device === "/dev/loop3")).toMatchObject({ uuid: "77AA-1B2C", fsType: null, problem: null })
  })

  it("an unreadable mountinfo lists nothing (better nothing than a system disk)", async () => {
    expect(await listUnmountedDevices(deps({ mountinfo: async () => { throw new Error("EACCES") } }))).toEqual([])
  })
})
