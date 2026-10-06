import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { withTempDir } from "../../../test/helpers/temp"
import { SysfsFixture } from "../../../test/fixtures/sysfs"
import { scanSerialPorts } from "./enumerate"
import { groupByAdapter } from "./group"

let tmp: { dir: string; cleanup: () => void }
beforeEach(() => { tmp = withTempDir("rm-group-") })
afterEach(() => tmp.cleanup())

async function scanStd() {
  const f = SysfsFixture.standard(tmp.dir)
  return scanSerialPorts({ sysRoot: f.sysRoot, devRoot: f.devRoot, extraGlobs: [], includeBuiltin: true })
}

describe("groupByAdapter", () => {
  it("one adapter per physical USB device, sorted by location (numeric-aware)", async () => {
    const adapters = groupByAdapter(await scanStd())
    expect(adapters.map((a) => a.locationKey)).toEqual([
      "pci-0000:00:14.0-usb-0:2",
      "pci-0000:00:14.0-usb-0:3.1",
      "pci-0000:00:14.0-usb-0:3.2",
      "pci-0000:00:14.0-usb-0:4",
      "pci-0000:00:14.0-usb-0:5",
      "pci-0000:00:14.0-usb-0:6",
    ])
  })

  it("ports ordered by (interface, port) regardless of the input order", async () => {
    const devs = (await scanStd()).reverse()
    const ft = groupByAdapter(devs).find((a) => a.locationKey.endsWith(":3.1"))
    expect(ft?.ports.map((p) => p.name)).toEqual(["ttyUSB0", "ttyUSB1", "ttyUSB2", "ttyUSB3"])
    const ch342 = groupByAdapter(devs).find((a) => a.locationKey.endsWith(":4"))
    expect(ch342?.ports.map((p) => p.usb?.interfaceNumber)).toEqual([0, 2])
  })

  it("identityKey is vid:pid:serial, null without a serial or with a duplicated one", async () => {
    const adapters = groupByAdapter(await scanStd())
    const by = new Map(adapters.map((a) => [a.locationKey.split(":").pop(), a]))
    expect(by.get("3.1")?.identityKey).toBe("0403:6011:FT4ABCDE")
    expect(by.get("5")?.identityKey).toBeNull()
    expect(by.get("5")?.hints).toEqual(["no-serial"])
    expect(by.get("2")?.hints).toEqual(["jtag-probable"])
  })

  it("labels and location come from src/lib/serial/format.ts", async () => {
    const adapters = groupByAdapter(await scanStd())
    const ft = adapters.find((a) => a.locationKey.endsWith(":3.1"))
    expect(ft?.label).toBe("FTDI Quad RS232-HS (FT4ABCDE)")
    expect(ft?.location).toBe("USB 1-3.1")
    const ch = adapters.find((a) => a.locationKey.endsWith(":5"))
    expect(ch?.label).toBe("USB Serial (sin nº de serie)")
  })

  it("non-USB ports are not grouped", async () => {
    const adapters = groupByAdapter(await scanStd())
    expect(adapters.flatMap((a) => a.ports).some((p) => p.name === "ttyS4")).toBe(false)
  })

  it("numeric-aware order puts port 10 after port 9", async () => {
    const f = new SysfsFixture(tmp.dir)
    for (const [port, tty] of [["10", "ttyUSB1"], ["9", "ttyUSB2"]] as const) {
      f.addUsbSerialAdapter({ port, vendorId: "0403", productId: "6001", manufacturer: "FTDI", product: "FT232R USB UART", serial: `S${port}`, numInterfaces: 1 },
        [{ iface: 0, tty, driver: "ftdi_sio" }])
    }
    const adapters = groupByAdapter(await scanSerialPorts({ sysRoot: f.sysRoot, devRoot: f.devRoot, extraGlobs: [], includeBuiltin: false }))
    expect(adapters.map((a) => a.locationKey)).toEqual(["pci-0000:00:14.0-usb-0:9", "pci-0000:00:14.0-usb-0:10"])
  })
})
