import { describe, expect, it } from "vitest"
import type { PortGroup, SerialPortDTO, UsbAdapterDTO } from "@/lib/contracts/serial"
import { suggestMapping } from "./mapping"

function usbPort(iface: number, over: Partial<SerialPortDTO> = {}): SerialPortDTO {
  return {
    stableKey: `usb:0403:6011:FT4ABCDE:if${iface}:p0`, name: `ttyUSB${iface}`, devNode: `/dev/ttyUSB${iface}`, kind: "usb", driver: "ftdi_sio",
    byId: null, byPath: null,
    usb: {
      vendorId: "0403", productId: "6011", manufacturer: "FTDI", product: "Quad RS232-HS", serial: "FT4ABCDE",
      interfaceNumber: iface, interfaceName: null, portNumber: 0, idPath: `pci-0000:00:14.0-usb-0:3.1:1.${iface}`, portPath: "1-3.1", busnum: 1, devnum: 7,
    },
    interfaceLetter: "ABCD"[iface] ?? `if${iface}`, accessible: true, accessError: null, hints: [], assignment: null, inUse: null,
    ...over,
  }
}

function adapterGroup(ports: SerialPortDTO[]): PortGroup {
  const adapter: UsbAdapterDTO = {
    locationKey: "pci-0000:00:14.0-usb-0:3.1", identityKey: "0403:6011:FT4ABCDE", vendorId: "0403", productId: "6011",
    manufacturer: "FTDI", product: "Quad RS232-HS", serial: "FT4ABCDE", label: "FTDI Quad RS232-HS (FT4ABCDE)", location: "USB 1-3.1", hints: [], ports,
  }
  return { key: adapter.locationKey, label: adapter.label, adapter, ports }
}

function virtualPort(n: number, over: Partial<SerialPortDTO> = {}): SerialPortDTO {
  return {
    stableKey: `virtual:/run/relay-manager/sim/ttyV${n}`, name: `ttyV${n}`, devNode: `/run/relay-manager/sim/ttyV${n}`, kind: "virtual", driver: null,
    byId: null, byPath: null, usb: null, interfaceLetter: null, accessible: true, accessError: null, hints: ["simulated"], assignment: null, inUse: null,
    ...over,
  }
}

const pseudo = (ports: SerialPortDTO[]): PortGroup => ({ key: "others", label: "Puertos virtuales y del sistema", adapter: null, ports })
const slots = (n: number, bound: number[] = []) => Array.from({ length: n }, (_, i) => ({ key: `C${i}`, bound: bound.includes(i) }))

describe("suggestMapping", () => {
  it("maps ports in interface order onto the slots in order", () => {
    const g = adapterGroup([usbPort(2), usbPort(0), usbPort(3), usbPort(1)])
    expect(suggestMapping(slots(4), g, { skipInterfaces: [], onlyFree: false })).toEqual([
      { slotIndex: 0, stableKey: usbPort(0).stableKey },
      { slotIndex: 1, stableKey: usbPort(1).stableKey },
      { slotIndex: 2, stableKey: usbPort(2).stableKey },
      { slotIndex: 3, stableKey: usbPort(3).stableKey },
    ])
  })

  it("skips the template's skipInterfaces (JTAG on if00)", () => {
    const g = adapterGroup([usbPort(0), usbPort(1), usbPort(2), usbPort(3)])
    expect(suggestMapping(slots(2), g, { skipInterfaces: [0], onlyFree: false })).toEqual([
      { slotIndex: 0, stableKey: usbPort(1).stableKey },
      { slotIndex: 1, stableKey: usbPort(2).stableKey },
    ])
  })

  it("onlyFree skips assigned ports and ports in use", () => {
    const g = adapterGroup([
      usbPort(0, { assignment: { equipmentId: "e1", equipmentName: "X", consoleId: "c1", consoleKey: "A", consoleLabel: "A" } }),
      usbPort(1, { inUse: "other" }),
      usbPort(2),
      usbPort(3, { inUse: "app" }),
    ])
    expect(suggestMapping(slots(2), g, { skipInterfaces: [], onlyFree: true })).toEqual([{ slotIndex: 0, stableKey: usbPort(2).stableKey }])
    expect(suggestMapping(slots(2), g, { skipInterfaces: [], onlyFree: false })).toHaveLength(2)
  })

  it("fewer ports than slots leaves the rest unmapped", () => {
    const g = adapterGroup([usbPort(0), usbPort(1)])
    expect(suggestMapping(slots(4), g, { skipInterfaces: [], onlyFree: false })).toEqual([
      { slotIndex: 0, stableKey: usbPort(0).stableKey },
      { slotIndex: 1, stableKey: usbPort(1).stableKey },
    ])
  })

  it("more ports than slots leaves the rest unused", () => {
    const g = adapterGroup([usbPort(0), usbPort(1), usbPort(2), usbPort(3)])
    expect(suggestMapping(slots(1), g, { skipInterfaces: [], onlyFree: false })).toEqual([{ slotIndex: 0, stableKey: usbPort(0).stableKey }])
  })

  it("already-bound slots are skipped (their index is kept)", () => {
    const g = adapterGroup([usbPort(0), usbPort(1), usbPort(2)])
    expect(suggestMapping(slots(3, [0]), g, { skipInterfaces: [], onlyFree: false })).toEqual([
      { slotIndex: 1, stableKey: usbPort(0).stableKey },
      { slotIndex: 2, stableKey: usbPort(1).stableKey },
    ])
  })

  it("pseudo-group of ptys: in group order, skipInterfaces ignored", () => {
    const g = pseudo([virtualPort(2), virtualPort(3)])
    expect(suggestMapping(slots(3), g, { skipInterfaces: [0], onlyFree: true })).toEqual([
      { slotIndex: 0, stableKey: virtualPort(2).stableKey },
      { slotIndex: 1, stableKey: virtualPort(3).stableKey },
    ])
  })

  it("no slots or no ports → empty", () => {
    expect(suggestMapping([], adapterGroup([usbPort(0)]), { skipInterfaces: [], onlyFree: false })).toEqual([])
    expect(suggestMapping(slots(2), pseudo([]), { skipInterfaces: [], onlyFree: false })).toEqual([])
  })
})
