// The mount helper (relay-manager-rootmount) on a temporary unix socket, with a fake sysfs, mountinfo, /proc/swaps and
// fake programs (blkid, mount, umount): device validation, refusing system disks, the mount options per filesystem, the
// mount folder, and the unmount rules. Run as the current user (as root under systemd in the bundle tests).
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { fakeHost, mountLine, startMountHelper, type FakeHost } from "../../../test/helpers/fake-sysfs"
import { mountCall } from "@/server/rootcopy/server"
import type { MountMessage } from "@/server/files/copy/protocol"
import { DEVICE_RE, mountDirName, mountOptions } from "./devices"

describe("devices (pure)", () => {
  it("device paths: only sd*, mmcblk*, nvme* (and loop for the tests), no tricks", () => {
    for (const ok of ["/dev/sdb", "/dev/sdb1", "/dev/sdaa12", "/dev/mmcblk0p1", "/dev/mmcblk0", "/dev/nvme0n1p3", "/dev/loop7"]) expect(DEVICE_RE.test(ok)).toBe(true)
    for (const bad of ["/dev/sda;rm -rf /", "/dev/../etc/passwd", "/etc/passwd", "sdb1", "/dev/sdb1 ", "/dev/dm-0", "/dev/md0", "/dev/sr0", "/dev/mapper/x", "/dev/sdb1\n"]) {
      expect(DEVICE_RE.test(bad)).toBe(false)
    }
  })
  it("mount options per filesystem: always nosuid,nodev,noexec; FAT/exFAT/NTFS for the sudo user + relay-files", () => {
    const ids = { uid: 1000, gid: 995 }
    expect(mountOptions("vfat", ids)).toBe("nosuid,nodev,noexec,uid=1000,gid=995,umask=0002,dmask=0002,fmask=0113,utf8,shortname=mixed")
    expect(mountOptions("exfat", ids)).toBe("nosuid,nodev,noexec,uid=1000,gid=995,umask=0002,dmask=0002,fmask=0113")
    expect(mountOptions("ntfs", ids)).toBe("nosuid,nodev,noexec,uid=1000,gid=995,umask=0002,dmask=0002,fmask=0113")
    expect(mountOptions("ext4", ids)).toBe("nosuid,nodev,noexec")
    expect(mountOptions("xfs", ids)).toBe("nosuid,nodev,noexec")
    expect(mountOptions("iso9660", ids)).toBe("ro,nosuid,nodev,noexec")
  })
  it("mount folder names: safe characters, label then uuid then device", () => {
    expect(mountDirName("MI USB", "1234", "sdb1")).toBe("MI_USB")
    expect(mountDirName("../../etc", null, "sdb1")).toBe("etc")
    expect(mountDirName("..", "AB-CD", "sdb1")).toBe("AB-CD")
    expect(mountDirName("Cámara", null, "sdb1")).toBe("Camara")
    expect(mountDirName(null, null, "sdb1")).toBe("sdb1")
    expect(mountDirName("x".repeat(100), null, "sdb1")).toHaveLength(64)
  })
})

describe("relay-manager-rootmount (mount helper) over a unix socket", () => {
  let tmp: string
  let host: FakeHost
  let sock: string
  let server: Awaited<ReturnType<typeof startMountHelper>>
  const call = (req: object): Promise<MountMessage> => mountCall(sock, req as never, 5000)

  beforeEach(async () => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rm-mount-")))
    host = fakeHost(tmp)
    sock = path.join(tmp, "rootmount.sock")
    server = await startMountHelper(host, sock)
  })
  afterEach(async () => {
    await new Promise((r) => server.close(r))
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it("mounts a FAT stick under /media/<sudo user>/<label> with the shared group, nosuid,nodev,noexec", async () => {
    const r = await call({ v: 1, op: "mount", device: "/dev/sdb1" })
    const dir = path.join(host.media, "ana", "MI_USB")
    expect(r).toEqual({ type: "result", op: "mount", device: "/dev/sdb1", mountPoint: dir, fsType: "vfat", options: "nosuid,nodev,noexec,uid=1000,gid=995,umask=0002,dmask=0002,fmask=0113,utf8,shortname=mixed" })
    expect(fs.statSync(dir).isDirectory()).toBe(true)
    expect(fs.statSync(path.join(host.media, "ana")).mode & 0o777).toBe(0o755)
    expect(host.calls.find((c) => c.op === "mount")?.args).toEqual({ type: "vfat", options: expect.stringContaining("nosuid,nodev,noexec"), device: "/dev/sdb1", dir })
    expect(JSON.parse(fs.readFileSync(path.join(tmp, "state", "created.json"), "utf8"))).toEqual([dir])
    // Mounted already → refused; a second stick with the same label gets "-2".
    expect(await call({ v: 1, op: "mount", device: "/dev/sdb1" })).toMatchObject({ type: "error", code: "EXISTS" })
    host.blkid["/dev/sdb2"] = { TYPE: "vfat", LABEL: "MI USB" }
    expect(await call({ v: 1, op: "mount", device: "/dev/sdb2" })).toMatchObject({ mountPoint: `${dir}-2` })
  })

  it("ext4: no owner options (writes go «como administrador»); exFAT whole-disk; NTFS with the kernel driver", async () => {
    expect(await call({ v: 1, op: "mount", device: "/dev/sdb2" })).toMatchObject({ fsType: "ext4", options: "nosuid,nodev,noexec", mountPoint: path.join(host.media, "ana", "0f0e-uuid") })
    expect(await call({ v: 1, op: "mount", device: "/dev/sdc" })).toMatchObject({ fsType: "exfat", options: expect.stringContaining("gid=995"), mountPoint: path.join(host.media, "ana", "CAMARA") })
    host.blkid["/dev/sdb1"] = { TYPE: "ntfs", LABEL: "Windows" }
    expect(await call({ v: 1, op: "mount", device: "/dev/sdb1" })).toMatchObject({ fsType: "ntfs3", options: expect.stringContaining("fmask=0113") })
  })

  it("refuses system disks, non-removable disks, swap, LVM, whole disks with partitions and bad paths", async () => {
    const refused = async (device: string, re: RegExp) => expect(await call({ v: 1, op: "mount", device })).toMatchObject({ type: "error", code: "DEVICE", message: expect.stringMatching(re) })
    await refused("/dev/sda1", /no es un dispositivo extraíble/)
    await refused("/dev/sdd1", /disco del sistema.*montado en \/srv\/raiz-usb/)
    await refused("/dev/sde1", /memoria de intercambio/)
    await refused("/dev/sdf1", /LVM, RAID o cifrado/)
    await refused("/dev/sdb", /tiene particiones/)
    await refused("/dev/loop7", /loop/)
    await refused("/etc/passwd", /no válido/)
    await refused("/dev/sdb1;reboot", /no válido/)
    expect(await call({ v: 1, op: "mount", device: "/dev/sdz1" })).toMatchObject({ type: "error", code: "NOT_FOUND" })
    expect(host.calls.filter((c) => c.op === "mount")).toEqual([])
    // Unknown or unsupported filesystems.
    host.blkid["/dev/sdb1"] = {}
    expect(await call({ v: 1, op: "mount", device: "/dev/sdb1" })).toMatchObject({ code: "DEVICE", message: expect.stringMatching(/sistema de ficheros reconocible/) })
    host.blkid["/dev/sdb1"] = { TYPE: "crypto_LUKS" }
    expect(await call({ v: 1, op: "mount", device: "/dev/sdb1" })).toMatchObject({ code: "DEVICE", message: expect.stringMatching(/no se monta desde aquí \(crypto_luks\)/) })
  })

  it("a failed mount leaves no folder behind", async () => {
    host.failMount.add("/dev/sdb1")
    expect(await call({ v: 1, op: "mount", device: "/dev/sdb1" })).toMatchObject({ type: "error", code: "IO", message: expect.stringMatching(/wrong fs type/) })
    expect(fs.readdirSync(path.join(host.media, "ana"))).toEqual([])
    expect(JSON.parse(fs.readFileSync(path.join(tmp, "state", "created.json"), "utf8"))).toEqual([])
  })

  it("never mounts through a folder others can change", async () => {
    fs.mkdirSync(path.join(host.media, "ana"), { mode: 0o775 })
    fs.chmodSync(path.join(host.media, "ana"), 0o777)
    expect(await call({ v: 1, op: "mount", device: "/dev/sdb1" })).toMatchObject({ type: "error", code: "DENIED" })
    fs.rmdirSync(path.join(host.media, "ana"))
    fs.symlinkSync("/etc", path.join(host.media, "ana"))
    expect(await call({ v: 1, op: "mount", device: "/dev/sdb1" })).toMatchObject({ type: "error", code: "DENIED", message: expect.stringMatching(/enlace/) })
    expect(host.calls.filter((c) => c.op === "mount")).toEqual([])
  })

  it("/media/<user> not traversable by others: the shared group gets an ACL (best effort)", async () => {
    fs.mkdirSync(path.join(host.media, "ana"))
    fs.chmodSync(path.join(host.media, "ana"), 0o750)
    await call({ v: 1, op: "mount", device: "/dev/sdb1" })
    expect(host.calls.find((c) => c.op === "setfacl")?.args).toEqual([path.join(host.media, "ana"), "relay-files"])
  })

  it("unmounts: sync, umount, the empty folder removed; only removable devices under /media", async () => {
    const m = await call({ v: 1, op: "mount", device: "/dev/sdb1" }) as { mountPoint: string }
    host.busy.add(m.mountPoint)
    expect(await call({ v: 1, op: "unmount", mountPoint: m.mountPoint })).toMatchObject({ type: "error", code: "IN_USE", message: expect.stringMatching(/en uso/) })
    expect(fs.existsSync(m.mountPoint)).toBe(true)
    host.busy.clear()
    expect(await call({ v: 1, op: "unmount", mountPoint: m.mountPoint })).toEqual({ type: "result", op: "unmount", mountPoint: m.mountPoint, removedDir: true })
    expect(host.calls.map((c) => c.op).filter((o) => o === "sync" || o === "umount")).toEqual(["sync", "umount", "sync", "umount"])
    expect(fs.existsSync(m.mountPoint)).toBe(false)
    // Outside /media, not mounted, a system disk mounted under /media, a tmpfs.
    expect(await call({ v: 1, op: "unmount", mountPoint: "/" })).toMatchObject({ code: "DEVICE" })
    expect(await call({ v: 1, op: "unmount", mountPoint: "/srv/raiz-usb" })).toMatchObject({ code: "DEVICE" })
    expect(await call({ v: 1, op: "unmount", mountPoint: `${host.media}/../etc` })).toMatchObject({ code: "DEVICE" })
    expect(await call({ v: 1, op: "unmount", mountPoint: path.join(host.media, "ana", "nada") })).toMatchObject({ code: "NOT_FOUND" })
    host.mounts.push(mountLine(300, "8:1", path.join(host.media, "efi"), "vfat", "/dev/sda1"))
    expect(await call({ v: 1, op: "unmount", mountPoint: path.join(host.media, "efi") })).toMatchObject({ code: "DEVICE" })
    host.mounts.push(mountLine(301, "0:55", path.join(host.media, "tmp"), "tmpfs", "tmpfs"))
    expect(await call({ v: 1, op: "unmount", mountPoint: path.join(host.media, "tmp") })).toMatchObject({ code: "DEVICE" })
  })

  it("loop devices only when the unit names one for the tests (RM_ROOTMOUNT_TEST_LOOP)", async () => {
    await new Promise((r) => server.close(r))
    server = await startMountHelper(host, sock, { testLoop: "/dev/loop7" })
    const r = await call({ v: 1, op: "mount", device: "/dev/loop7" })
    expect(r).toMatchObject({ type: "result", mountPoint: path.join(host.media, "ana", "PRUEBA") })
    expect(await call({ v: 1, op: "unmount", mountPoint: path.join(host.media, "ana", "PRUEBA") })).toMatchObject({ removedDir: true })
  })

  it("disabled: only ping answers; garbage is a protocol error", async () => {
    await new Promise((r) => server.close(r))
    server = await startMountHelper(host, sock, { enabled: false })
    expect(await call({ v: 1, op: "ping" })).toEqual({ type: "result", op: "ping", version: "test" })
    expect(await call({ v: 1, op: "mount", device: "/dev/sdb1" })).toMatchObject({ code: "DISABLED" })
    expect(await call({ v: 1, op: "format", device: "/dev/sdb1" })).toMatchObject({ code: "PROTOCOL" })
  })
})
