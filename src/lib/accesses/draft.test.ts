import { describe, expect, it } from "vitest"
import type { AccessDTO, CableLabelDTO, JtagCableDTO } from "@/lib/contracts/accesses"
import {
  accessDraftFromDTO, accessDraftFromSlot, cableChoices, followConsoleRenames, newAccessDraft, previewPorts, toAccessInputs, toTemplateAccessSlots,
  validateAccessDrafts,
} from "./draft"

const settings = { range: { from: 3201, to: 3230 }, bind: "0.0.0.0", httpPort: 3200, maxConnections: 8 }
const cable = (serial: string, p: Partial<JtagCableDTO> = {}): JtagCableDTO => ({
  serial, vendorId: "0403", productId: "6014", manufacturer: "Digilent", product: "Digilent USB Device", family: "digilent", location: "USB 1-2",
  labelId: null, labelName: null, assignedTo: [], ...p,
})
const label = (name: string, identity: string, p: Partial<CableLabelDTO> = {}): CableLabelDTO => ({
  id: `l-${name}`, kind: "jtag", identity, name, notes: null, vendorId: "0403", productId: "6014", product: "Digilent USB Device",
  firstSeenAt: "2026-09-25T10:00:00.000Z", lastSeenAt: null, connected: false, assignedTo: [], ...p,
})

describe("access drafts", () => {
  it("from a template slot: automatic port, cable label resolved when known", () => {
    const d = accessDraftFromSlot({ key: "JTAG0", label: "JTAG 0", kind: "jtag", policy: "reserved", consoleKey: null, targetHost: null, targetPort: null, cableName: "JTAG-07", targetMode: "ip", sshUser: null }, "u1", (name) => (name === "JTAG-07" ? "210299A1" : null))
    expect(d).toEqual({ uid: "u1", key: "JTAG0", label: "JTAG 0", kind: "jtag", policy: "reserved", enabled: true, port: null, cableSerial: "210299A1", consoleKey: null, targetHost: "", targetPort: null, targetMode: "ip", switchPort: null, sshUser: null, cableName: "JTAG-07" })
  })
  it("from a saved access keeps its id and port", () => {
    const a = { id: "a1", equipmentId: "e", position: 0, key: "ETH", label: "Ethernet", kind: "tcp", port: 3205, enabled: false, policy: "always", cableSerial: null, cableName: null, consoleId: null, consoleKey: null, targetHost: "10.0.0.2", targetPort: 22 } as AccessDTO
    expect(accessDraftFromDTO(a, "u9")).toMatchObject({ uid: "u9", id: "a1", port: 3205, enabled: false, policy: "always", targetHost: "10.0.0.2", targetPort: 22 })
  })
  it("new rows get a free key and sensible defaults per kind", () => {
    expect(newAccessDraft("jtag", ["JTAG_1"], "u2")).toMatchObject({ key: "JTAG_2", label: "JTAG 2", kind: "jtag" })
    expect(newAccessDraft("serial", [], "u3")).toMatchObject({ key: "SERIE_1", label: "Serie 1", kind: "serial" })
    expect(newAccessDraft("tcp", ["ETH"], "u4")).toMatchObject({ key: "ETH_2", label: "Ethernet 2", kind: "tcp", targetPort: 22 })
  })
  it("inputs for the server and slots for the template", () => {
    const rows = [
      { ...newAccessDraft("jtag", [], "a"), cableSerial: "210299A1" },
      { ...newAccessDraft("serial", [], "b"), consoleKey: "UART0", port: 3210 },
      { ...newAccessDraft("tcp", [], "c"), targetHost: " 10.0.0.2 ", id: "x1" },
    ]
    expect(toAccessInputs(rows)).toEqual([
      { key: "JTAG_1", label: "JTAG 1", kind: "jtag", enabled: true, policy: "reserved", port: null, cableSerial: "210299A1", cableName: null, consoleKey: null, targetHost: null, targetPort: null, targetMode: "ip", switchPort: null, sshUser: null },
      { key: "SERIE_1", label: "Serie 1", kind: "serial", enabled: true, policy: "reserved", port: 3210, cableSerial: null, cableName: null, consoleKey: "UART0", targetHost: null, targetPort: null, targetMode: "ip", switchPort: null, sshUser: null },
      { id: "x1", key: "ETH_1", label: "Ethernet 1", kind: "tcp", enabled: true, policy: "reserved", port: null, cableSerial: null, cableName: null, consoleKey: null, targetHost: "10.0.0.2", targetPort: 22, targetMode: "ip", switchPort: null, sshUser: "root" },
    ])
    // Switch mode: the port goes with it; a blank host means "the equipment IP" of the equipment network.
    const sw = { ...newAccessDraft("tcp", [], "d", { switchMode: true }), switchPort: 4 }
    expect(toAccessInputs([sw])[0]).toMatchObject({ targetMode: "switch", switchPort: 4, targetHost: null, targetPort: 22, sshUser: "root" })
    expect(toAccessInputs([{ ...sw, targetMode: "ip" }])[0]).toMatchObject({ targetMode: "ip", switchPort: null })
    expect(toTemplateAccessSlots(rows).map((s) => [s.key, s.kind, s.consoleKey, s.targetHost, s.targetPort, s.cableName])).toEqual([
      ["JTAG_1", "jtag", null, null, null, null], ["SERIE_1", "serial", "UART0", null, null, null], ["ETH_1", "tcp", null, "10.0.0.2", 22, null],
    ])
  })
  it("previewPorts matches the server's allocation (fixed first, then lowest free)", () => {
    const rows = [newAccessDraft("jtag", [], "a"), { ...newAccessDraft("tcp", [], "b"), port: 3201 }, newAccessDraft("serial", [], "c")]
    expect(previewPorts(rows, { settings, usedPorts: [3202] })).toEqual([3203, 3201, 3204])
    expect(previewPorts(rows, { settings: { ...settings, range: { from: 3201, to: 3202 } }, usedPorts: [3202] })).toEqual([null, 3201, null])
  })
  it("follows console key renames by row uid", () => {
    const rows = [{ ...newAccessDraft("serial", [], "a"), consoleKey: "UART" }, { ...newAccessDraft("serial", [], "b"), consoleKey: "UART1" }]
    const out = followConsoleRenames(rows, [{ uid: "c1", key: "UART" }, { uid: "c2", key: "UART1" }], [{ uid: "c1", key: "UART0" }])
    expect(out.map((r) => r.consoleKey)).toEqual(["UART0", null])
  })
})

describe("cableChoices", () => {
  it("labelled connected free cables first, then used elsewhere, then disconnected, then unlabelled ones", () => {
    const ctx = {
      jtag: { scannedAt: "", cables: [
        cable("S1", { labelId: "l-JTAG-01", labelName: "JTAG-01" }),
        cable("S2", { labelId: "l-JTAG-02", labelName: "JTAG-02", assignedTo: [{ equipmentId: "e2", equipmentName: "Equipo A #02", id: "a", key: "JTAG0", label: "JTAG 0" }] }),
        cable("S9"),
        cable("S3", { labelId: "l-JTAG-03", labelName: "JTAG-03", assignedTo: [{ equipmentId: "e1", equipmentName: "Equipo A #01", id: "b", key: "JTAG1", label: "JTAG 1" }] }),
      ] },
      labels: [label("JTAG-01", "S1", { connected: true }), label("JTAG-02", "S2", { connected: true }), label("JTAG-03", "S3", { connected: true }), label("JTAG-04", "S4")],
    }
    const c = cableChoices(ctx, { equipmentId: "e1", takenInDraft: ["S1"], current: null })
    expect(c.map((x) => [x.serial, x.name, x.group, x.takenInDraft])).toEqual([
      ["S3", "JTAG-03", "free", false],
      ["S1", "JTAG-01", "free", true],
      ["S2", "JTAG-02", "used", false],
      ["S4", "JTAG-04", "offline", false],
      ["S9", null, "unlabelled", false],
    ])
    expect(c[2].usedBy).toEqual(["JTAG0 · Equipo A #02"])
  })
})

describe("validateAccessDrafts", () => {
  it("reports repeated keys and ports, unknown consoles, bad ports and hosts with dotted keys", () => {
    const rows = [
      { ...newAccessDraft("jtag", [], "a"), port: 3210 },
      { ...newAccessDraft("jtag", [], "b"), port: 3210 },
      { ...newAccessDraft("serial", [], "c"), consoleKey: "NOPE" },
      { ...newAccessDraft("tcp", [], "d"), targetHost: "no valido!", port: 70000 },
    ]
    const fe = validateAccessDrafts(rows, ["UART0"])
    expect(Object.keys(fe).sort()).toEqual(["accesses.1.key", "accesses.1.port", "accesses.2.consoleKey", "accesses.3.port", "accesses.3.targetHost"])
    expect(validateAccessDrafts([{ ...newAccessDraft("serial", [], "c"), consoleKey: "UART0" }], ["UART0"])).toEqual({})
  })
})
