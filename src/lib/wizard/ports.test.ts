import { describe, expect, it } from "vitest"
import type { PortGroup, SerialPortDTO, SerialSnapshotDTO } from "@/lib/contracts/serial"
import { suggestMapping } from "@/lib/serial/mapping"
import {
  allPorts, defaultGroupKey, defaultMatchBy, findPort, groupForMapping, hostnamesOf, interfaceList, isFreePort, isPreviewable,
  draftPortHolder, lacksUniqueSerial, portName, portShort, withDraftHolders,
} from "./ports"

function usbPort(i: number, over: Partial<SerialPortDTO> = {}): SerialPortDTO {
  return {
    stableKey: `usb:0403:6011:FT4ABCDE:if0${i}:p0`, name: `ttyUSB${i}`, devNode: `/dev/ttyUSB${i}`, kind: "usb", driver: "ftdi_sio",
    byId: `/dev/serial/by-id/usb-FTDI_Quad_RS232-HS_FT4ABCDE-if0${i}-port0`, byPath: null,
    usb: { vendorId: "0403", productId: "6011", manufacturer: "FTDI", product: "Quad RS232-HS", serial: "FT4ABCDE", interfaceNumber: i, interfaceName: null, portNumber: 0, idPath: null, portPath: "3.1", busnum: 1, devnum: 5 },
    interfaceLetter: String.fromCharCode(65 + i), accessible: true, accessError: null, hints: [], assignment: null, inUse: null, ...over,
  }
}
function pty(n: number, over: Partial<SerialPortDTO> = {}): SerialPortDTO {
  return {
    stableKey: `virtual:/run/user/1000/sim/ttyV${n}`, name: `ttyV${n}`, devNode: `/run/user/1000/sim/ttyV${n}`, kind: "virtual", driver: null,
    byId: null, byPath: null, usb: null, interfaceLetter: null, accessible: true, accessError: null, hints: ["simulated"], assignment: null, inUse: null, ...over,
  }
}
const adapterGroup: PortGroup = { key: "loc", label: "FTDI", adapter: null, ports: [usbPort(0), usbPort(1), usbPort(2), usbPort(3)] }
const ptys: PortGroup = { key: "others", label: "Puertos virtuales y del sistema", adapter: null, ports: [pty(0), pty(1), pty(2)] }
const snapshot: SerialSnapshotDTO = { scannedAt: "2026-09-23T10:00:00.000Z", adapters: [], others: ptys.ports, hiddenJtag: 0, watcher: { inotify: true, intervalMs: 2000 } }

describe("wizard port helpers", () => {
  it("names ports for the strip and for lists", () => {
    expect(portShort(usbPort(1))).toBe("FT4ABCDE·B")
    expect(portShort(usbPort(1, { hints: ["duplicate-serial"] }))).toBe("USB 3.1·B")
    expect(portShort(pty(0))).toBe("ttyV0")
    expect(portName(usbPort(2))).toBe("C · ttyUSB2")
    expect(portName(pty(1))).toBe("ttyV1")
  })

  it("tells free, previewable and uniquely identified ports apart", () => {
    expect(isFreePort(pty(0))).toBe(true)
    expect(isFreePort(pty(0, { inUse: "app" }))).toBe(true)
    expect(isFreePort(pty(0, { inUse: "other" }))).toBe(false)
    expect(isFreePort(pty(0, { accessible: false, accessError: "EACCES" }))).toBe(false)
    const bound = pty(0, { assignment: { equipmentId: "e", equipmentName: "E", consoleId: "c", consoleKey: "K", consoleLabel: "K" } })
    expect(isFreePort(bound)).toBe(false)
    expect(isPreviewable(bound)).toBe(false)
    expect(lacksUniqueSerial(usbPort(0))).toBe(false)
    expect(lacksUniqueSerial(usbPort(0, { hints: ["no-serial"] }))).toBe(true)
    expect(defaultMatchBy(usbPort(0))).toBe("adapter")
    expect(defaultMatchBy(usbPort(0, { hints: ["no-serial"] }))).toBe("usb-port")
    expect(defaultMatchBy(pty(0))).toBe("path")
  })

  it("maps in order even while previews hold the ports, and skips ports the draft already uses", () => {
    const previewing: PortGroup = { ...ptys, ports: ptys.ports.map((p) => ({ ...p, inUse: "app" as const })) }
    const slots = [{ key: "UART0", bound: false }, { key: "UART1", bound: false }]
    expect(suggestMapping(slots, previewing, { skipInterfaces: [], onlyFree: true })).toEqual([])
    const g = groupForMapping(previewing, new Set([pty(0).stableKey]))
    expect(suggestMapping(slots, g, { skipInterfaces: [], onlyFree: true }).map((m) => m.stableKey)).toEqual([pty(1).stableKey, pty(2).stableKey])
  })

  it("picks the group with the most free ports first", () => {
    const busy: PortGroup = { ...adapterGroup, ports: adapterGroup.ports.map((p) => ({ ...p, inUse: "other" as const })) }
    expect(defaultGroupKey([busy, ptys])).toBe("others")
    expect(defaultGroupKey([adapterGroup, ptys])).toBe("loc")
    expect(defaultGroupKey([])).toBeNull()
  })

  it("finds ports, lists hostnames and formats skipped interfaces", () => {
    expect(allPorts(snapshot)).toHaveLength(3)
    expect(findPort(snapshot, pty(2).stableKey)?.name).toBe("ttyV2")
    expect(findPort(snapshot, "virtual:/nope")).toBeNull()
    expect(findPort(snapshot, null)).toBeNull()
    expect(hostnamesOf({ a: { stableKey: "a", devNode: null, state: "login", hostname: "equipo-a-01-uart1", openByApp: true, poked: false, sample: "", error: null, ms: 1 } })).toEqual({ a: "equipo-a-01-uart1" })
    expect(interfaceList([2, 0])).toBe("0 (A), 2 (C)")
  })

  it("shows ports held by the draft as assigned to this equipment, and ports the draft freed as free", () => {
    const saved = pty(2, { assignment: { equipmentId: "eq1", equipmentName: "Equipo A #01", consoleId: "c1", consoleKey: "UART1", consoleLabel: "UART1" } })
    const s: SerialSnapshotDTO = { ...snapshot, adapters: [{ ...({} as SerialSnapshotDTO["adapters"][number]), ports: [usbPort(0)] }], others: [pty(0), pty(1), saved] }
    const holders: Record<string, string | null> = { [pty(0).stableKey]: "UART0", [saved.stableKey]: null, [usbPort(0).stableKey]: "AUX" }
    const out = withDraftHolders(s, (p) => holders[p.stableKey], "este equipo")
    expect(findPort(out, pty(0).stableKey)?.assignment).toMatchObject({ equipmentName: "este equipo", consoleKey: "UART0" })
    expect(findPort(out, usbPort(0).stableKey)?.assignment?.consoleKey).toBe("AUX")
    expect(findPort(out, pty(1).stableKey)?.assignment).toBeNull()
    expect(findPort(out, saved.stableKey)?.assignment).toBeNull()
    expect(findPort(s, pty(0).stableKey)?.assignment).toBeNull()
    expect(withDraftHolders(s, () => undefined, "este equipo")).toEqual(s)
  })

  it("draftPortHolder never relabels a port that another equipment holds now (the conflict stays visible)", () => {
    const other = pty(0, { assignment: { equipmentId: "eq-B", equipmentName: "Equipo A #05", consoleId: "c9", consoleKey: "UART1", consoleLabel: "UART1" } })
    const own = pty(1, { assignment: { equipmentId: "eq-A", equipmentName: "Equipo A #01", consoleId: "c1", consoleKey: "UART0", consoleLabel: "UART0" } })
    // Wizard (no equipment yet): every live assignment is someone else's.
    expect(draftPortHolder(other, "UART0", null)).toBeUndefined()
    expect(draftPortHolder(pty(2), "UART0", null)).toBe("UART0")
    expect(draftPortHolder(pty(2), null, null)).toBeUndefined()
    // Ajustes of eq-A.
    expect(draftPortHolder(other, "UART0", "eq-A")).toBeUndefined()
    expect(draftPortHolder(own, "UART1", "eq-A")).toBe("UART1")
    expect(draftPortHolder(own, null, "eq-A")).toBeNull()
    const out = withDraftHolders({ ...snapshot, others: [other] }, (p) => draftPortHolder(p, "UART0", null), "este equipo")
    expect(out.others[0]?.assignment).toMatchObject({ equipmentName: "Equipo A #05", consoleKey: "UART1" })
  })
})
