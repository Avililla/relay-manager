import { describe, expect, it } from "vitest"
import type { ConsoleBindingRecord } from "@/lib/contracts/serial"
import {
  adapterLabel, adapterShort, captureDownloadName, consoleAdapterLabel, interfaceLetter, locationLabel, sanitizeDescriptor,
} from "./format"

const ftdi = { vendorId: "0403", productId: "6011", manufacturer: "FTDI", product: "Quad RS232-HS", serial: "FT4ABCDE" }

function binding(p: Partial<ConsoleBindingRecord>): ConsoleBindingRecord {
  return {
    matchBy: "adapter", bindingKey: "usb:0403:6011:FT4ABCDE:if1:p0", byId: null, byPath: null,
    usbVendorId: "0403", usbProductId: "6011", usbSerial: "FT4ABCDE", usbInterface: 1, usbPortNumber: 0,
    usbIdPath: "pci-0000:00:14.0-usb-0:3.1:1.1", devicePath: null, adapterLabel: "FTDI Quad RS232-HS (FT4ABCDE) · B",
    lastDevNode: "/dev/ttyUSB1", ...p,
  }
}

describe("adapterLabel", () => {
  it("manufacturer + product (serial)", () => {
    expect(adapterLabel(ftdi)).toBe("FTDI Quad RS232-HS (FT4ABCDE)")
  })
  it("product that already names the manufacturer is not repeated", () => {
    expect(adapterLabel({ ...ftdi, manufacturer: "Digilent", product: "Digilent USB Device", serial: "210299ABCDEF" })).toBe("Digilent USB Device (210299ABCDEF)")
  })
  it("no serial → 'sin nº de serie'", () => {
    expect(adapterLabel({ vendorId: "1a86", productId: "7523", manufacturer: null, product: "USB Serial", serial: null })).toBe("USB Serial (sin nº de serie)")
  })
  it("no strings → vid:pid", () => {
    expect(adapterLabel({ vendorId: "1a86", productId: "7523", manufacturer: null, product: null, serial: null })).toBe("1a86:7523 (sin nº de serie)")
  })
  it("only manufacturer", () => {
    expect(adapterLabel({ ...ftdi, product: null })).toBe("FTDI (FT4ABCDE)")
  })
})

describe("locationLabel", () => {
  it("USB <bus>-<port path>", () => {
    expect(locationLabel({ busnum: 1, portPath: "1-3.1" })).toBe("USB 1-3.1")
    expect(locationLabel({ busnum: 3, portPath: "3-2" })).toBe("USB 3-2")
  })
})

describe("interfaceLetter", () => {
  it("A B C D from the interface number on multi-interface adapters", () => {
    expect(interfaceLetter(0, 0, false)).toBe("A")
    expect(interfaceLetter(1, 0, false)).toBe("B")
    expect(interfaceLetter(3, 0, false)).toBe("D")
  })
  it("if<N> on single-interface adapters", () => {
    expect(interfaceLetter(0, 0, true)).toBe("if0")
  })
  it("appends the port number when an interface has several ports", () => {
    expect(interfaceLetter(0, 1, false)).toBe("A1")
  })
})

describe("consoleAdapterLabel", () => {
  it("<adapter label> · <letter>", () => {
    expect(consoleAdapterLabel("FTDI Quad RS232-HS (FT4ABCDE)", "B")).toBe("FTDI Quad RS232-HS (FT4ABCDE) · B")
  })
  it("is capped at 120 characters", () => {
    expect(consoleAdapterLabel("x".repeat(200), "A").length).toBeLessThanOrEqual(120)
    expect(consoleAdapterLabel("x".repeat(200), "A").endsWith(" · A")).toBe(true)
  })
})

describe("adapterShort", () => {
  it("unique serial → <serial>·<letter>", () => {
    expect(adapterShort(binding({}))).toBe("FT4ABCDE·B")
  })
  it("letter from the stored adapterLabel (if0 on single-interface adapters)", () => {
    expect(adapterShort(binding({ usbInterface: 0, adapterLabel: "FTDI FT232R USB UART (A50285BI) · if0", bindingKey: "usb:0403:6001:A50285BI:if0:p0", usbSerial: "A50285BI" }))).toBe("A50285BI·if0")
  })
  it("letter falls back to the interface number", () => {
    expect(adapterShort(binding({ adapterLabel: null, usbInterface: 2 }))).toBe("FT4ABCDE·C")
  })
  it("no unique serial → USB <port path>·<letter>", () => {
    expect(adapterShort(binding({
      matchBy: "usb-port", bindingKey: "path:pci-0000:00:14.0-usb-0:5:1.0:if0:p0", usbSerial: null, usbInterface: 0,
      usbIdPath: "pci-0000:00:14.0-usb-0:5:1.0", adapterLabel: "USB Serial (sin nº de serie) · if0", usbVendorId: "1a86", usbProductId: "7523",
    }))).toBe("USB 5·if0")
    expect(adapterShort(binding({ bindingKey: "path:pci-0000:00:14.0-usb-0:3.1:1.1:if1:p0" }))).toBe("USB 3.1·B")
  })
  it("virtual and builtin ports → the file name", () => {
    expect(adapterShort(binding({
      matchBy: "path", bindingKey: "virtual:/run/relay-manager/sim/ttyV0", usbVendorId: null, usbProductId: null, usbSerial: null,
      usbInterface: null, usbPortNumber: null, usbIdPath: null, devicePath: "/run/relay-manager/sim/ttyV0", adapterLabel: "ttyV0 (virtual)", lastDevNode: "/run/relay-manager/sim/ttyV0",
    }))).toBe("ttyV0")
    expect(adapterShort(binding({
      matchBy: "path", bindingKey: "dev:ttyS4", usbVendorId: null, usbProductId: null, usbSerial: null,
      usbInterface: null, usbPortNumber: null, usbIdPath: null, devicePath: "/dev/ttyS4", adapterLabel: null, lastDevNode: "/dev/ttyS4",
    }))).toBe("ttyS4")
  })
  it("unbound → null", () => {
    expect(adapterShort(null)).toBeNull()
  })
})

describe("sanitizeDescriptor", () => {
  it("strips control characters and caps at 64", () => {
    expect(sanitizeDescriptor("\x1b[31mEvil\x07\u0085 name\n")).toBe("[31mEvil name")
    expect(sanitizeDescriptor("x".repeat(100))).toHaveLength(64)
    expect(sanitizeDescriptor("   ")).toBeNull()
    expect(sanitizeDescriptor(null)).toBeNull()
  })
})

describe("captureDownloadName", () => {
  it("ascii slug <equipo>_<KEY>_<file> plus a UTF-8 name", () => {
    expect(captureDownloadName("Equipo A #07", "UART0", "2026-09-23.log")).toEqual({
      ascii: "equipo-a-07_uart0_2026-09-23.log",
      utf8: "Equipo A #07_UART0_2026-09-23.log",
    })
    expect(captureDownloadName("Cámara ñ", "AUX", "2026-09-23.1.log.gz").ascii).toBe("camara-n_aux_2026-09-23.1.log.gz")
  })
})
