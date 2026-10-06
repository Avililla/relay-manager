import { describe, expect, it } from "vitest"
import { adapterIdentity, cableProduct, cableTitle, newArrivals, nextCableName } from "./labels"

describe("nextCableName", () => {
  it("suggests JTAG-01 / USB-01 and the next free number", () => {
    expect(nextCableName("jtag", [])).toBe("JTAG-01")
    expect(nextCableName("serial-adapter", [])).toBe("USB-01")
    expect(nextCableName("jtag", ["JTAG-01", "jtag-02", "JTAG-07"])).toBe("JTAG-08")
    expect(nextCableName("jtag", ["Mi cable"])).toBe("JTAG-01")
    expect(nextCableName("jtag", Array.from({ length: 120 }, (_, i) => `JTAG-${String(i + 1).padStart(2, "0")}`))).toBe("JTAG-121")
  })
})

describe("adapterIdentity", () => {
  it("uses vid:pid:serial when unique, else the USB location", () => {
    expect(adapterIdentity({ identityKey: "0403:6011:FT4ABCDE", locationKey: "pci-0000:00:14.0-usb-0:3.1" })).toBe("0403:6011:FT4ABCDE")
    expect(adapterIdentity({ identityKey: null, locationKey: "pci-0000:00:14.0-usb-0:3.1" })).toBe("loc:pci-0000:00:14.0-usb-0:3.1")
  })
})

describe("cableTitle", () => {
  it("puts the label first and the serial second", () => {
    expect(cableTitle("JTAG-07", "210299A1B2C3")).toEqual({ primary: "JTAG-07", secondary: "210299A1B2C3" })
    expect(cableTitle(null, "210299A1B2C3")).toEqual({ primary: "210299A1B2C3", secondary: null })
    expect(cableTitle(null, null)).toEqual({ primary: "Sin número de serie", secondary: null })
  })
})

describe("newArrivals", () => {
  it("returns identities present now and not at the baseline, in order", () => {
    expect(newArrivals(["a", "b"], ["b", "c", "a", "d"])).toEqual(["c", "d"])
    expect(newArrivals([], [])).toEqual([])
  })
})

describe("cableProduct", () => {
  it("does not repeat the maker when the product already names it", () => {
    expect(cableProduct("Digilent", "Digilent USB Device", "0403:6014")).toBe("Digilent USB Device")
    expect(cableProduct("Xilinx", "Platform Cable USB II", "03fd:0008")).toBe("Xilinx Platform Cable USB II")
    expect(cableProduct(null, "JTAG-HS3", "0403:6014")).toBe("JTAG-HS3")
    expect(cableProduct("FTDI", null, "0403:6010")).toBe("FTDI")
    expect(cableProduct(null, null, "0403:6010")).toBe("0403:6010")
  })
})
