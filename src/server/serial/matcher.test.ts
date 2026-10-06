import fs from "node:fs"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { ConsoleBindingRecordSchema, type ConsoleBindingRecord } from "@/lib/contracts/serial"
import { withTempDir } from "../../../test/helpers/temp"
import { SysfsFixture } from "../../../test/fixtures/sysfs"
import { scanSerialPorts, type SerialDevice } from "./enumerate"
import { bindingFromDevice, resolveBinding } from "./matcher"

let tmp: { dir: string; cleanup: () => void }
beforeEach(() => { tmp = withTempDir("rm-match-") })
afterEach(() => tmp.cleanup())

async function scan(f: SysfsFixture, extraGlobs: string[] = [], includeBuiltin = false): Promise<SerialDevice[]> {
  return scanSerialPorts({ sysRoot: f.sysRoot, devRoot: f.devRoot, extraGlobs, includeBuiltin })
}
const find = (devs: SerialDevice[], name: string): SerialDevice => {
  const d = devs.find((x) => x.name === name)
  if (!d) throw new Error(`no ${name}`)
  return d
}
function okName(r: ReturnType<typeof resolveBinding>): string | null {
  return r.status === "ok" ? r.device.name : null
}

describe("bindingFromDevice", () => {
  it("defaults: adapter with a unique serial, usb-port without, path for virtual/builtin; valid records", async () => {
    const f = SysfsFixture.standard(tmp.dir)
    const devs = await scan(f, [], true)
    const ft = bindingFromDevice(find(devs, "ttyUSB2"))
    expect(ft).toMatchObject({
      matchBy: "adapter", bindingKey: "usb:0403:6011:FT4ABCDE:if2:p0",
      byId: "/dev/serial/by-id/usb-FTDI_Quad_RS232-HS_FT4ABCDE-if02-port0",
      byPath: "/dev/serial/by-path/pci-0000:00:14.0-usb-0:3.1:1.2-port0",
      usbVendorId: "0403", usbProductId: "6011", usbSerial: "FT4ABCDE", usbInterface: 2, usbPortNumber: 0,
      usbIdPath: "pci-0000:00:14.0-usb-0:3.1:1.2", devicePath: null, adapterLabel: "FTDI Quad RS232-HS (FT4ABCDE) · C", lastDevNode: "/dev/ttyUSB2",
    })
    expect(bindingFromDevice(find(devs, "ttyUSB6")).matchBy).toBe("usb-port")
    expect(bindingFromDevice(find(devs, "ttyUSB6")).adapterLabel).toBe("USB Serial (sin nº de serie) · if0")
    const s4 = bindingFromDevice(find(devs, "ttyS4"))
    expect(s4).toMatchObject({ matchBy: "path", devicePath: "/dev/ttyS4", bindingKey: "dev:ttyS4", usbVendorId: null })
    for (const d of devs) expect(ConsoleBindingRecordSchema.safeParse(bindingFromDevice(d)).success).toBe(true)
  })

  it("an explicit matchBy wins", async () => {
    const devs = await scan(SysfsFixture.standard(tmp.dir))
    expect(bindingFromDevice(find(devs, "ttyUSB2"), "usb-port").matchBy).toBe("usb-port")
    const p = bindingFromDevice(find(devs, "ttyUSB2"), "path")
    expect(p.matchBy).toBe("path")
    expect(p.devicePath).toBe("/dev/serial/by-path/pci-0000:00:14.0-usb-0:3.1:1.2-port0")
  })

  it("virtual ports keep the literal path", async () => {
    const f = new SysfsFixture(tmp.dir)
    const sim = path.join(tmp.dir, "sim")
    fs.mkdirSync(sim)
    fs.writeFileSync(path.join(tmp.dir, "pts3"), "")
    fs.symlinkSync(path.join(tmp.dir, "pts3"), path.join(sim, "ttyV0"))
    const [v] = await scan(f, [path.join(sim, "ttyV*")])
    const b = bindingFromDevice(v)
    expect(b).toMatchObject({ matchBy: "path", devicePath: path.join(sim, "ttyV0"), lastDevNode: path.join(sim, "ttyV0"), bindingKey: `virtual:${path.join(sim, "ttyV0")}` })
    expect(ConsoleBindingRecordSchema.safeParse(b).success).toBe(true)
  })
})

describe("resolveBinding", () => {
  it("unchanged adapter via its serial", async () => {
    const devs = await scan(SysfsFixture.standard(tmp.dir))
    const b = bindingFromDevice(find(devs, "ttyUSB2"))
    const r = resolveBinding(b, devs)
    expect(okName(r)).toBe("ttyUSB2")
  })

  it("adapter moved to another USB socket and renumbered, without /dev/serial → still found via serial", async () => {
    const f1 = new SysfsFixture(path.join(tmp.dir, "a"))
    f1.addFt4232h("3.1", "FT4ABCDE", 0)
    const b = bindingFromDevice(find(await scan(f1), "ttyUSB2"))
    const f2 = new SysfsFixture(path.join(tmp.dir, "b"))
    f2.addFt4232h("7", "FT4ABCDE", 10)
    f2.removeSerialLinks()
    const r = resolveBinding(b, await scan(f2))
    expect(okName(r)).toBe("ttyUSB12")
  })

  it("the same move with matchBy usb-port → missing", async () => {
    const f1 = new SysfsFixture(path.join(tmp.dir, "a"))
    f1.addFt4232h("3.1", "FT4ABCDE", 0)
    const b = bindingFromDevice(find(await scan(f1), "ttyUSB2"), "usb-port")
    const f2 = new SysfsFixture(path.join(tmp.dir, "b"))
    f2.addFt4232h("7", "FT4ABCDE", 10)
    expect(resolveBinding(b, await scan(f2)).status).toBe("missing")
  })

  it("serial-less CH340 found via its USB socket without /dev/serial", async () => {
    const f = SysfsFixture.standard(tmp.dir)
    const b = bindingFromDevice(find(await scan(f), "ttyUSB6"))
    f.removeSerialLinks()
    expect(okName(resolveBinding(b, await scan(f)))).toBe("ttyUSB6")
  })

  it("duplicate serial: tie-break on the stored socket, otherwise ambiguous", async () => {
    const f = new SysfsFixture(tmp.dir)
    for (const [port, tty] of [["8", "ttyUSB20"], ["9", "ttyUSB21"]] as const) {
      f.addUsbSerialAdapter(
        { port, vendorId: "10c4", productId: "ea60", manufacturer: "Silicon Labs", product: "CP2102", serial: "0001", numInterfaces: 1 },
        [{ iface: 0, tty, driver: "cp210x" }],
      )
    }
    const devs = await scan(f)
    const b: ConsoleBindingRecord = { ...bindingFromDevice(find(devs, "ttyUSB21")), matchBy: "adapter" }
    expect(okName(resolveBinding(b, devs))).toBe("ttyUSB21")
    const r = resolveBinding({ ...b, usbIdPath: "pci-0000:00:14.0-usb-0:11:1.0" }, devs)
    expect(r.status).toBe("ambiguous")
  })

  it("adapter mode with a different adapter in the socket → missing; usb-port mode → ok with a warning", async () => {
    const f1 = new SysfsFixture(path.join(tmp.dir, "a"))
    f1.addFt4232h("3.1", "FT4ABCDE", 0)
    const b = bindingFromDevice(find(await scan(f1), "ttyUSB1"))
    const f2 = new SysfsFixture(path.join(tmp.dir, "b"))
    f2.addFt4232h("3.1", "FT4OTHER", 0)
    const devs = await scan(f2)
    expect(resolveBinding(b, devs).status).toBe("missing")
    const r = resolveBinding({ ...b, matchBy: "usb-port" }, devs)
    expect(okName(r)).toBe("ttyUSB1")
    expect(r.status === "ok" ? r.warning : null).toBe("En ese puerto USB hay otro adaptador")
  })

  it("path mode (virtual): literal device path", async () => {
    const f = new SysfsFixture(tmp.dir)
    const sim = path.join(tmp.dir, "sim")
    fs.mkdirSync(sim)
    fs.writeFileSync(path.join(tmp.dir, "pts1"), "")
    fs.symlinkSync(path.join(tmp.dir, "pts1"), path.join(sim, "ttyV1"))
    const devs = await scan(f, [path.join(sim, "ttyV*")])
    const b = bindingFromDevice(devs[0])
    expect(okName(resolveBinding(b, devs))).toBe("ttyV1")
    expect(okName(resolveBinding({ ...b, devicePath: null }, devs))).toBe("ttyV1") // lastDevNode, path mode only
  })

  it("lastDevNode is never an identity outside path mode (ttyUSBn renumbering)", async () => {
    const devs = await scan(SysfsFixture.standard(tmp.dir))
    const b: ConsoleBindingRecord = {
      ...bindingFromDevice(find(devs, "ttyUSB2")),
      usbSerial: "GONE", usbIdPath: "pci-0000:00:14.0-usb-0:9:1.2", byId: null, byPath: null,
    }
    expect(b.lastDevNode).toBe("/dev/ttyUSB2")
    expect(resolveBinding(b, devs).status).toBe("missing")
  })

  it("never returns a device outside the snapshot, whatever the binding says", async () => {
    const devs = await scan(SysfsFixture.standard(tmp.dir))
    const b: ConsoleBindingRecord = {
      matchBy: "path", bindingKey: "dev:ttyS9", byId: "/dev/serial/by-id/nope", byPath: null, usbVendorId: null, usbProductId: null,
      usbSerial: null, usbInterface: null, usbPortNumber: null, usbIdPath: null, devicePath: "/dev/ttyS9", adapterLabel: null, lastDevNode: "/dev/ttyS9",
    }
    expect(resolveBinding(b, devs).status).toBe("missing")
    expect(resolveBinding({ ...b, devicePath: "/etc/passwd" }, devs).status).toBe("missing")
    for (const d of devs) {
      const r = resolveBinding(bindingFromDevice(d), devs)
      if (r.status === "ok") expect(devs).toContain(r.device)
    }
  })

  it("by-id link match in path mode", async () => {
    const devs = await scan(SysfsFixture.standard(tmp.dir))
    const b = bindingFromDevice(find(devs, "ttyUSB3"), "path")
    expect(okName(resolveBinding({ ...b, devicePath: "/dev/serial/by-id/usb-FTDI_Quad_RS232-HS_FT4ABCDE-if03-port0" }, devs))).toBe("ttyUSB3")
  })
})
