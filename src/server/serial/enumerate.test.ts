import fs from "node:fs"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { withTempDir } from "../../../test/helpers/temp"
import { SysfsFixture } from "../../../test/fixtures/sysfs"
import { createDescribeCache, scanSerialPorts, type SerialDevice } from "./enumerate"

const isRoot = typeof process.getuid === "function" && process.getuid() === 0

let tmp: { dir: string; cleanup: () => void }
beforeEach(() => { tmp = withTempDir("rm-enum-") })
afterEach(() => tmp.cleanup())

function byName(devs: SerialDevice[]): Map<string, SerialDevice> {
  return new Map(devs.map((d) => [d.name, d]))
}

describe("scanSerialPorts (sysfs)", () => {
  it("enumerates the standard fixture: kinds, interfaces, port numbers, idPath, links, stable keys", async () => {
    const f = SysfsFixture.standard(tmp.dir)
    const devs = byName(await scanSerialPorts({ sysRoot: f.sysRoot, devRoot: f.devRoot, extraGlobs: [], includeBuiltin: false }))
    expect([...devs.keys()].sort()).toEqual(["ttyACM0", "ttyACM1", "ttyUSB0", "ttyUSB1", "ttyUSB2", "ttyUSB3", "ttyUSB4", "ttyUSB5", "ttyUSB6", "ttyUSB7", "ttyUSB8"])

    const u2 = devs.get("ttyUSB2")
    expect(u2).toMatchObject({
      devNode: "/dev/ttyUSB2", openPath: path.join(f.devRoot, "ttyUSB2"), kind: "usb", driver: "ftdi_sio",
      stableKey: "usb:0403:6011:FT4ABCDE:if2:p0", accessible: true, accessError: null, hints: [],
      byId: ["/dev/serial/by-id/usb-FTDI_Quad_RS232-HS_FT4ABCDE-if02-port0"],
      byPath: ["/dev/serial/by-path/pci-0000:00:14.0-usb-0:3.1:1.2-port0"],
    })
    expect(u2?.usb).toMatchObject({
      vendorId: "0403", productId: "6011", manufacturer: "FTDI", product: "Quad RS232-HS", serial: "FT4ABCDE",
      interfaceNumber: 2, portNumber: 0, idPath: "pci-0000:00:14.0-usb-0:3.1:1.2", portPath: "1-3.1", busnum: 1, devnum: 7, numInterfaces: 4,
    })

    expect(devs.get("ttyUSB4")?.usb).toMatchObject({ interfaceNumber: 0, interfaceName: "Enhanced Com Port" })
    expect(devs.get("ttyUSB5")?.usb).toMatchObject({ interfaceNumber: 1, interfaceName: "Standard Com Port" })

    const acm1 = devs.get("ttyACM1")
    expect(acm1).toMatchObject({ kind: "usb", driver: "cdc_acm", stableKey: "usb:1a86:55d2:5959012345:if2:p0" })
    expect(acm1?.usb).toMatchObject({ interfaceNumber: 2, portNumber: 0, idPath: "pci-0000:00:14.0-usb-0:4:1.2" })
    expect(acm1?.byId).toEqual(["/dev/serial/by-id/usb-1a86_USB_Dual_Serial_5959012345-if02"])
  })

  it("hints: no-serial (CH340), jtag-probable (Digilent), duplicate by-id link kept only on the last one", async () => {
    const f = SysfsFixture.standard(tmp.dir)
    const devs = byName(await scanSerialPorts({ sysRoot: f.sysRoot, devRoot: f.devRoot, extraGlobs: [], includeBuiltin: false }))
    const u6 = devs.get("ttyUSB6")
    expect(u6?.hints).toEqual(["no-serial"])
    expect(u6?.stableKey).toBe("path:pci-0000:00:14.0-usb-0:5:1.0:if0:p0")
    expect(u6?.byId).toEqual([])
    expect(devs.get("ttyUSB7")?.byId).toEqual(["/dev/serial/by-id/usb-1a86_USB_Serial-if00-port0"])
    expect(devs.get("ttyUSB8")?.hints).toEqual(["jtag-probable"])
    expect(devs.get("ttyUSB8")?.usb?.serial).toBe("210299ABCDEF")
  })

  it("duplicate serial at two locations → duplicate-serial and a path: stable key", async () => {
    const f = new SysfsFixture(tmp.dir)
    for (const [port, tty] of [["8", "ttyUSB20"], ["9", "ttyUSB21"]] as const) {
      f.addUsbSerialAdapter(
        { port, vendorId: "10c4", productId: "ea60", manufacturer: "Silicon Labs", product: "CP2102 USB to UART Bridge Controller", serial: "0001", numInterfaces: 1 },
        [{ iface: 0, tty, driver: "cp210x" }],
      )
    }
    const devs = byName(await scanSerialPorts({ sysRoot: f.sysRoot, devRoot: f.devRoot, extraGlobs: [], includeBuiltin: false }))
    expect(devs.get("ttyUSB20")?.hints).toEqual(["duplicate-serial"])
    expect(devs.get("ttyUSB20")?.stableKey).toBe("path:pci-0000:00:14.0-usb-0:8:1.0:if0:p0")
    expect(devs.get("ttyUSB21")?.stableKey).toBe("path:pci-0000:00:14.0-usb-0:9:1.0:if0:p0")
  })

  it("builtin ports only with includeBuiltin, and never the phantom type-0 8250", async () => {
    const f = SysfsFixture.standard(tmp.dir)
    const without = byName(await scanSerialPorts({ sysRoot: f.sysRoot, devRoot: f.devRoot, extraGlobs: [], includeBuiltin: false }))
    expect(without.has("ttyS4")).toBe(false)
    const withB = byName(await scanSerialPorts({ sysRoot: f.sysRoot, devRoot: f.devRoot, extraGlobs: [], includeBuiltin: true }))
    expect(withB.has("ttyS0")).toBe(false)
    expect(withB.get("ttyS4")).toMatchObject({ kind: "platform", stableKey: "dev:ttyS4", hints: ["builtin"], usb: null, devNode: "/dev/ttyS4" })
  })

  it.skipIf(isRoot)("EACCES when the node is not readable/writable", async () => {
    const f = SysfsFixture.standard(tmp.dir)
    f.chmodDev("ttyUSB5", 0o000)
    const devs = byName(await scanSerialPorts({ sysRoot: f.sysRoot, devRoot: f.devRoot, extraGlobs: [], includeBuiltin: false }))
    expect(devs.get("ttyUSB5")).toMatchObject({ accessible: false, accessError: "EACCES" })
  })

  it("ENOENT when sysfs shows the tty but /dev does not (container without the host /dev)", async () => {
    const f = SysfsFixture.standard(tmp.dir)
    f.removeDevNode("ttyUSB1")
    const devs = byName(await scanSerialPorts({ sysRoot: f.sysRoot, devRoot: f.devRoot, extraGlobs: [], includeBuiltin: false }))
    expect(devs.get("ttyUSB1")).toMatchObject({ accessible: false, accessError: "ENOENT" })
  })

  it("devRoot /hostdev is shown and stored as the canonical /dev/... path", async () => {
    const f = SysfsFixture.standard(tmp.dir, { devDirName: "hostdev" })
    const devs = byName(await scanSerialPorts({ sysRoot: f.sysRoot, devRoot: f.devRoot, extraGlobs: [], includeBuiltin: false }))
    expect(devs.get("ttyUSB0")).toMatchObject({
      devNode: "/dev/ttyUSB0",
      openPath: path.join(tmp.dir, "hostdev", "ttyUSB0"),
      byId: ["/dev/serial/by-id/usb-FTDI_Quad_RS232-HS_FT4ABCDE-if00-port0"],
    })
  })

  it("works without /dev/serial (no links at all)", async () => {
    const f = SysfsFixture.standard(tmp.dir)
    f.removeSerialLinks()
    const devs = byName(await scanSerialPorts({ sysRoot: f.sysRoot, devRoot: f.devRoot, extraGlobs: [], includeBuiltin: false }))
    expect(devs.get("ttyUSB0")?.byId).toEqual([])
    expect(devs.get("ttyUSB0")?.usb?.idPath).toBe("pci-0000:00:14.0-usb-0:3.1:1.0")
  })

  it("extra globs → virtual ports (last component only); dangling links are skipped", async () => {
    const f = new SysfsFixture(tmp.dir)
    const sim = path.join(tmp.dir, "sim")
    fs.mkdirSync(sim)
    fs.writeFileSync(path.join(tmp.dir, "pts0"), "")
    fs.symlinkSync(path.join(tmp.dir, "pts0"), path.join(sim, "ttyV0"))
    fs.symlinkSync(path.join(tmp.dir, "missing"), path.join(sim, "ttyV1"))
    fs.writeFileSync(path.join(sim, "other"), "")
    const devs = await scanSerialPorts({ sysRoot: f.sysRoot, devRoot: f.devRoot, extraGlobs: [path.join(sim, "ttyV*")], includeBuiltin: false })
    expect(devs).toHaveLength(1)
    expect(devs[0]).toMatchObject({
      name: "ttyV0", devNode: path.join(sim, "ttyV0"), openPath: path.join(sim, "ttyV0"), kind: "virtual", usb: null,
      stableKey: `virtual:${path.join(sim, "ttyV0")}`, hints: ["simulated"], accessible: true, target: path.join(tmp.dir, "pts0"),
    })
  })

  it("descriptor strings are untrusted: control characters stripped, capped at 64", async () => {
    const f = new SysfsFixture(tmp.dir)
    f.addUsbSerialAdapter(
      { port: "7", vendorId: "0403", productId: "6001", manufacturer: "Evil\x1b[2J\x07", product: "P".repeat(100), serial: "AB\x00CD", numInterfaces: 1 },
      [{ iface: 0, tty: "ttyUSB30", driver: "ftdi_sio" }],
    )
    const [d] = await scanSerialPorts({ sysRoot: f.sysRoot, devRoot: f.devRoot, extraGlobs: [], includeBuiltin: false })
    expect(d.usb?.manufacturer).toBe("Evil[2J")
    expect(d.usb?.product).toHaveLength(64)
    expect(d.usb?.serial).toBe("ABCD")
    expect(d.stableKey).toBe("usb:0403:6001:ABCD:if0:p0")
  })

  it("caches the USB description per (name, busnum, devnum)", async () => {
    const f = SysfsFixture.standard(tmp.dir)
    const cache = createDescribeCache()
    const opts = { sysRoot: f.sysRoot, devRoot: f.devRoot, extraGlobs: [], includeBuiltin: false, cache }
    await scanSerialPorts(opts)
    fs.writeFileSync(path.join(f.handles.ft4232h.dir, "product"), "Changed\n")
    expect(byName(await scanSerialPorts(opts)).get("ttyUSB0")?.usb?.product).toBe("Quad RS232-HS")
    fs.writeFileSync(path.join(f.handles.ft4232h.dir, "devnum"), "9\n")   // re-enumerated device
    expect(byName(await scanSerialPorts(opts)).get("ttyUSB0")?.usb?.product).toBe("Changed")
  })

  it("a ttyUSB whose USB interface is gone is skipped (never a non-USB port) and not cached", async () => {
    const f = SysfsFixture.standard(tmp.dir)
    const cache = createDescribeCache()
    const opts = { sysRoot: f.sysRoot, devRoot: f.devRoot, extraGlobs: [], includeBuiltin: false, cache }
    const ifaceFile = path.join(f.handles.ft4232h.dir, `${f.handles.ft4232h.name}:1.1`, "bInterfaceNumber")
    fs.renameSync(ifaceFile, `${ifaceFile}.gone`)          // the interface is being torn down
    const during = byName(await scanSerialPorts(opts))
    expect(during.has("ttyUSB1")).toBe(false)
    expect([...during.values()].filter((d) => d.usb === null)).toEqual([])
    fs.renameSync(`${ifaceFile}.gone`, ifaceFile)          // same name, same devReal: must be described again
    expect(byName(await scanSerialPorts(opts)).get("ttyUSB1")).toMatchObject({ kind: "usb", stableKey: "usb:0403:6011:FT4ABCDE:if1:p0" })
  })

  it("a scan racing an unplug never reports a ttyUSB as non-USB nor with a half-read description", async () => {
    const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms))
    for (let i = 0; i < 120; i++) {
      const dir = path.join(tmp.dir, `r${i}`)
      const f = new SysfsFixture(dir)
      const dev = f.addUsbDevice({ port: "3.1", vendorId: "0403", productId: "6011", manufacturer: "FTDI", product: "Quad RS232-HS", serial: "FT4ABCDE", numInterfaces: 4 })
      for (let k = 0; k < 4; k++) f.addUsbSerialTty(f.addInterface(dev, k, "ftdi_sio"), `ttyUSB${k}`, 0, "ftdi_sio")
      const cache = createDescribeCache()
      const opts = { sysRoot: f.sysRoot, devRoot: f.devRoot, extraGlobs: [], includeBuiltin: false, cache }
      if (i % 2 === 1) await scanSerialPorts(opts)                       // odd rounds: warm cache
      const scan = scanSerialPorts(opts)
      if (i % 4 >= 2) await sleepMs(i % 3)
      f.removeUsbDevice(dev)
      for (const d of await scan) {
        expect(d).toMatchObject({ kind: "usb", driver: "ftdi_sio", stableKey: `usb:0403:6011:FT4ABCDE:if${d.name.slice(-1)}:p0` })
        expect(d.usb).toMatchObject({ serial: "FT4ABCDE", interfaceNumber: Number(d.name.slice(-1)), busnum: 1, devnum: 7 })
      }
      expect(await scanSerialPorts(opts)).toEqual([])                     // nothing stale left in the cache
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("a steady-state scan of 12 ports stays fast with the cache", async () => {
    const f = SysfsFixture.standard(tmp.dir)
    const cache = createDescribeCache()
    const opts = { sysRoot: f.sysRoot, devRoot: f.devRoot, extraGlobs: [], includeBuiltin: true, cache }
    await scanSerialPorts(opts)
    const t0 = performance.now()
    for (let i = 0; i < 10; i++) await scanSerialPorts(opts)
    expect((performance.now() - t0) / 10).toBeLessThan(50)
  })

  it("a missing sysfs class dir gives no ports", async () => {
    expect(await scanSerialPorts({ sysRoot: path.join(tmp.dir, "nope"), devRoot: path.join(tmp.dir, "nodev"), extraGlobs: [], includeBuiltin: true })).toEqual([])
  })

  it("non-Linux platforms fall back to SerialPort.list() as kind platform", async () => {
    const devs = await scanSerialPorts({
      sysRoot: "/sys", devRoot: "/dev", extraGlobs: [], includeBuiltin: false, platform: "darwin",
      listPorts: async () => [{ path: "/dev/tty.usbserial-A1", manufacturer: "FTDI", serialNumber: "A1", vendorId: "0403", productId: "6001" }],
    })
    expect(devs).toEqual([expect.objectContaining({ name: "tty.usbserial-A1", devNode: "/dev/tty.usbserial-A1", kind: "platform", usb: null, stableKey: "dev:/dev/tty.usbserial-A1" })])
  })
})
