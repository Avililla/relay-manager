import { afterEach, describe, expect, it } from "vitest"
import { classifyJtag, scanJtagCables } from "./jtag-enumerate"
import { SysfsFixture } from "../../../test/fixtures/sysfs"
import { withTempDir } from "../../../test/helpers"

let cleanup: (() => void) | null = null
afterEach(() => { cleanup?.(); cleanup = null })
async function inTemp(fn: (dir: string) => Promise<void>): Promise<void> {
  const t = withTempDir()
  cleanup = t.cleanup
  await fn(t.dir)
}

describe("classifyJtag", () => {
  it("recognises Digilent (FTDI and own VID), Xilinx and FTDI JTAG boards; ignores plain adapters", () => {
    expect(classifyJtag({ vendorId: "0403", productId: "6014", manufacturer: "Digilent", product: "Digilent USB Device" })).toBe("digilent")
    expect(classifyJtag({ vendorId: "1443", productId: "0007", manufacturer: null, product: "Digilent Adept USB Device" })).toBe("digilent")
    expect(classifyJtag({ vendorId: "03fd", productId: "0008", manufacturer: "Xilinx", product: "Platform Cable USB II" })).toBe("xilinx")
    expect(classifyJtag({ vendorId: "0403", productId: "6011", manufacturer: "Xilinx", product: "JTAG+3Serial" })).toBe("ftdi")
    expect(classifyJtag({ vendorId: "0403", productId: "6011", manufacturer: "FTDI", product: "Quad RS232-HS" })).toBeNull()
    expect(classifyJtag({ vendorId: "10c4", productId: "ea70", manufacturer: "Silicon Labs", product: "CP2105" })).toBeNull()
  })
})

describe("scanJtagCables", () => {
  it("lists the JTAG cables of the standard fixture plus a Platform Cable, with serial and location", async () => {
    await inTemp(async (dir) => {
      const f = SysfsFixture.standard(dir)
      f.addXilinxPlatformCable("7")
      const cables = await scanJtagCables(f.sysRoot)
      expect(cables.map((c) => [c.serial, c.family, c.location])).toEqual([
        ["210299ABCDEF", "digilent", "USB 1-2"],
        ["000013ca3a2001", "xilinx", "USB 1-7"],
      ])
      expect(cables[0]).toMatchObject({ vendorId: "0403", productId: "6014", manufacturer: "Digilent", product: "Digilent USB Device" })
    })
  })
  it("sees a cable appear and disappear (hot-plug) and survives a missing bus directory", async () => {
    await inTemp(async (dir) => {
      const f = new SysfsFixture(dir)
      expect(await scanJtagCables(f.sysRoot)).toEqual([])
      const h = f.addDigilentHs3("4", "ttyUSB0")
      expect((await scanJtagCables(f.sysRoot)).map((c) => c.serial)).toEqual(["210299ABCDEF"])
      f.removeUsbDevice(h)
      expect(await scanJtagCables(f.sysRoot)).toEqual([])
      expect(await scanJtagCables(`${dir}/nope`)).toEqual([])
    })
  })
})
