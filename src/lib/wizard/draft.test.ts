import { describe, expect, it } from "vitest"
import { CreateEquipmentInputSchema } from "@/lib/contracts/equipment"
import { DEFAULT_LINE } from "@/lib/contracts/enums"
import type { SerialPortDTO, SerialSnapshotDTO } from "@/lib/contracts/serial"
import type { TemplateDTO } from "@/lib/contracts/templates"
import {
  applyChoice, applyMapping, assignPort, BLANK, bindingConflicts, buildCreateInput, choiceLosesWork, emptyDraft, errorRows, isWizardDirty,
  portHolder, pruneAssignments, remapCreateErrors, stepForErrors, suggestName, takenChannels, validateIdentity, validateSlots, type WizardDraft,
} from "./draft"

const equipoA: TemplateDTO = {
  id: "tplA", key: "equipo-a", name: "Equipo A", description: null, source: "local", sourceFile: null, retired: false, needsReview: true, position: 0, equipmentCount: 1,
  updatedAt: "2026-09-23T10:00:00.000Z",
  spec: {
    version: 1, namePattern: "Equipo A #{nn}", skipInterfaces: [],
    consoles: [
      { key: "UART0", label: "UART0", line: { ...DEFAULT_LINE }, enterMode: "cr", localEcho: false, identify: { hostnameRegex: "uart0" } },
      { key: "UART1", label: "UART1", line: { ...DEFAULT_LINE }, enterMode: "cr", localEcho: false, identify: { hostnameRegex: "uart1" } },
    ],
    relays: [],
    accesses: [],
  },
}
const custom: TemplateDTO = {
  ...equipoA, id: "tplC", key: null, name: "Rack", needsReview: false,
  spec: { ...equipoA.spec, namePattern: "Rack {n}", relays: [
    { key: "POWER", label: "Alimentación", purpose: "power", requireConfirm: true, defaultPulseMs: null },
    { key: "RESET", label: "Reset", purpose: "reset", requireConfirm: false, defaultPulseMs: 500 },
  ] },
}
const TEXT = { required: "Obligatorio", nameTaken: "Ya existe", tooLong: (n: number) => `Máximo ${n}` }

function counter() {
  let n = 0
  return () => `u${++n}`
}

function started(t: TemplateDTO, names: string[] = []): WizardDraft {
  return applyChoice(emptyDraft(), t.id, [equipoA, custom], names, counter())
}

describe("wizard draft", () => {
  it("seeds consoles and relays from the template and suggests the next free name", () => {
    const d = started(equipoA, ["Equipo A #01", "equipo a #02"])
    expect(d.consoles.map((c) => c.key)).toEqual(["UART0", "UART1"])
    expect(d.consoles[0]).toMatchObject({ hupcl: false, captureToDisk: true, identify: { hostnameRegex: "uart0" } })
    expect(d.relays).toEqual([])
    expect(d.name).toBe("Equipo A #03")
  })

  it("En blanco starts with no consoles and no relays", () => {
    const d = applyChoice(emptyDraft(), BLANK, [equipoA], [], counter())
    expect(d.consoles).toEqual([])
    expect(d.relays).toEqual([])
    expect(d.name).toBe("Equipo #01")
    expect(suggestName(null, ["Equipo #01"])).toBe("Equipo #02")
  })

  it("resets the slots when another template is chosen, but keeps a name the user typed", () => {
    let d = started(equipoA)
    d = assignPort(d, d.consoles[0].uid, { stableKey: "k0", matchBy: "path" })
    d = { ...d, name: "Mi unidad", nameTouched: true }
    const next = applyChoice(d, custom.id, [equipoA, custom], [], counter())
    expect(next.relays.map((r) => r.key)).toEqual(["POWER", "RESET"])
    expect(next.bindings).toEqual({})
    expect(next.name).toBe("Mi unidad")
    expect(applyChoice(next, custom.id, [equipoA, custom], [], counter())).toBe(next)
  })

  it("validates slot keys, duplicates and labels with dotted keys in Spanish", () => {
    const d = started(equipoA)
    d.consoles[1] = { ...d.consoles[1], key: "UART0" }
    d.consoles[0] = { ...d.consoles[0], label: " " }
    const fe = validateSlots({ consoles: d.consoles, relays: [{ uid: "r", key: null, label: "x", purpose: "generic", requireConfirm: false, defaultPulseMs: null }] })
    expect(fe["consoles.1.key"]).toEqual(["Clave repetida: UART0"])
    expect(fe["consoles.0.label"]).toEqual(["Obligatorio"])
    expect(fe["relays.0.key"]?.[0]).toMatch(/mayúsculas/)
    expect(validateSlots(started(equipoA))).toEqual({})
  })

  it("rejects an invalid identify expression", () => {
    const d = started(equipoA)
    d.consoles[0] = { ...d.consoles[0], identify: { hostnameRegex: "(" } }
    expect(validateSlots(d)["consoles.0.identify.hostnameRegex"]).toEqual(["Expresión regular no válida"])
  })

  it("validates the identity step", () => {
    expect(validateIdentity({ name: " ", serialNumber: "", description: "" }, [], TEXT)).toEqual({ name: ["Obligatorio"] })
    expect(validateIdentity({ name: "equipo a #01", serialNumber: "", description: "" }, ["Equipo A #01"], TEXT)).toEqual({ name: ["Ya existe"] })
    expect(validateIdentity({ name: "X", serialNumber: "S".repeat(61), description: "d".repeat(501) }, [], TEXT)).toEqual({ serialNumber: ["Máximo 60"], description: ["Máximo 500"] })
  })

  it("builds a createEquipment input that the contract accepts, leaving out relays without a board", () => {
    let d = started(custom)
    d = assignPort(d, d.consoles[1].uid, { stableKey: "virtual:/run/user/1000/sim/ttyV1", matchBy: "path" })
    d = { ...d, relayTargets: { [d.relays[1].uid]: { boardId: "b1", channel: 3 }, [d.relays[0].uid]: "skip" }, serialNumber: "  EA-0008 ", roleIds: ["r1"] }
    const { input, relayIndex } = buildCreateInput(d, custom)
    expect(relayIndex).toEqual([1])
    expect(input.relays).toEqual([{ key: "RESET", label: "Reset", purpose: "reset", requireConfirm: false, defaultPulseMs: 500, boardId: "b1", channel: 3 }])
    expect(input.consoles.map((c) => c.binding)).toEqual([null, { stableKey: "virtual:/run/user/1000/sim/ttyV1", matchBy: "path" }])
    expect(input.serialNumber).toBe("EA-0008")
    expect(input.description).toBeNull()
    expect(input.templateId).toBe("tplC")
    expect(input.templateUpdate).toBeNull()
    expect(CreateEquipmentInputSchema.safeParse(input).success).toBe(true)
  })

  it("sends the whole slot draft as templateUpdate, skipped relays included and without equipment-only fields", () => {
    let d = started(custom)
    d = { ...d, saveToTemplate: true, consoles: [...d.consoles, { ...d.consoles[1], uid: "x", key: "AUX", label: "Aux", hupcl: true, captureToDisk: false }] }
    d = assignPort(d, "x", { stableKey: "virtual:/run/user/1000/sim/ttyV9", matchBy: "path" })
    const { input } = buildCreateInput(d, custom)
    expect(input.templateUpdate?.consoles.map((c) => c.key)).toEqual(["UART0", "UART1", "AUX"])
    expect(input.templateUpdate?.relays.map((r) => r.key)).toEqual(["POWER", "RESET"])
    expect(JSON.stringify(input.templateUpdate)).not.toMatch(/hupcl|captureToDisk|binding|uid|stableKey/)
    expect(CreateEquipmentInputSchema.safeParse(input).success).toBe(true)
    expect(buildCreateInput({ ...d, saveToTemplate: true }, null).input.templateUpdate).toBeNull()
  })

  it("maps server errors back to draft rows and to the step they belong to", () => {
    const fe = remapCreateErrors({ "relays.0.channel": ["Canal ocupado"], "templateUpdate.consoles.2.key": ["Clave repetida"], "consoles.1.binding": ["No conectado"] }, [1])
    expect(fe).toEqual({ "relays.1.channel": ["Canal ocupado"], "consoles.2.key": ["Clave repetida"], "consoles.1.binding": ["No conectado"] })
    expect(stepForErrors({ name: ["x"] })).toBe(4)
    expect(stepForErrors({ "accesses.2.port": ["x"], name: ["y"] })).toBe(3)
    expect(remapCreateErrors({ "templateUpdate.accesses.1.consoleKey": ["x"] }, [])).toEqual({ "accesses.1.consoleKey": ["x"] })
    expect(stepForErrors({ "consoles.1.binding": ["x"], name: ["y"] })).toBe(2)
    expect(stepForErrors({ "relays.0.boardId": ["x"] })).toBe(2)
    expect(stepForErrors({ "consoles.0.key": ["x"], "consoles.1.binding": ["y"] })).toBe(1)
    expect(stepForErrors({ templateId: ["x"] })).toBe(0)
    expect(stepForErrors({ _form: ["x"] })).toBeNull()
    expect([...errorRows(fe, "consoles")].sort()).toEqual([1, 2])
  })

  it("keeps one console per port when assigning and applying a mapping", () => {
    let d = started(equipoA)
    const [a, b] = d.consoles
    d = assignPort(d, a.uid, { stableKey: "p1", matchBy: "path" })
    d = assignPort(d, b.uid, { stableKey: "p1", matchBy: "path" })
    expect(d.bindings).toEqual({ [b.uid]: { stableKey: "p1", matchBy: "path" } })
    d = applyMapping(d, [{ slotIndex: 0, stableKey: "p2" }, { slotIndex: 1, stableKey: "p3" }], () => "adapter")
    expect(d.bindings[a.uid]).toEqual({ stableKey: "p2", matchBy: "adapter" })
    expect(d.bindings[b.uid]).toEqual({ stableKey: "p3", matchBy: "adapter" })
    expect(assignPort(d, a.uid, null).bindings[a.uid]).toBeUndefined()
  })

  it("prunes assignments of removed rows and lists channels taken by other slots", () => {
    let d = started(custom)
    d = assignPort(d, d.consoles[0].uid, { stableKey: "p1", matchBy: "path" })
    d = { ...d, relayTargets: { [d.relays[0].uid]: { boardId: "b", channel: 1 }, [d.relays[1].uid]: { boardId: "b", channel: 2 } } }
    expect(takenChannels(d, d.relays[0].uid)).toEqual(["b:2"])
    const pruned = pruneAssignments({ ...d, consoles: d.consoles.slice(1), relays: d.relays.slice(1) })
    expect(Object.keys(pruned.bindings)).toEqual([])
    expect(Object.keys(pruned.relayTargets)).toEqual([d.relays[1].uid])
    expect(pruneAssignments(d)).toBe(d)
  })

  it("is dirty only after a real change", () => {
    const d = started(equipoA)
    expect(isWizardDirty(d, d)).toBe(false)
    expect(isWizardDirty({ ...d, serialNumber: "x" }, d)).toBe(true)
    expect(isWizardDirty(assignPort(d, d.consoles[0].uid, { stableKey: "p", matchBy: "path" }), d)).toBe(true)
  })

  it("knows when changing the template would throw away slot edits, ports or board channels", () => {
    const templates = [equipoA, custom]
    const d = started(equipoA)
    expect(choiceLosesWork(emptyDraft(), templates)).toBe(false)
    expect(choiceLosesWork(d, templates)).toBe(false)
    expect(choiceLosesWork({ ...d, name: "Otro", nameTouched: true, serialNumber: "S1" }, templates)).toBe(false)
    expect(choiceLosesWork({ ...d, consoles: d.consoles.slice(1) }, templates)).toBe(true)
    expect(choiceLosesWork({ ...d, consoles: [{ ...d.consoles[0], label: "Seguridad" }, d.consoles[1]] }, templates)).toBe(true)
    expect(choiceLosesWork(assignPort(d, d.consoles[0].uid, { stableKey: "p", matchBy: "path" }), templates)).toBe(true)
    const r = started(custom)
    expect(choiceLosesWork({ ...r, relayTargets: { [r.relays[0].uid]: "skip" } }, templates)).toBe(true)
    const blank = applyChoice(emptyDraft(), BLANK, templates, [], counter())
    expect(choiceLosesWork(blank, templates)).toBe(false)
    expect(choiceLosesWork({ ...blank, consoles: [d.consoles[0]] }, templates)).toBe(true)
  })

  it("flags bound ports that the live snapshot already shows as taken by another equipment", () => {
    const port = (stableKey: string, assignment: SerialPortDTO["assignment"]): SerialPortDTO => ({
      stableKey, name: stableKey, devNode: `/run/sim/${stableKey}`, kind: "virtual", driver: null, byId: null, byPath: null, usb: null,
      interfaceLetter: null, accessible: true, accessError: null, hints: [], assignment, inUse: null,
    })
    const snapshot: SerialSnapshotDTO = {
      scannedAt: "2026-09-24T10:00:00.000Z", adapters: [], hiddenJtag: 0, watcher: { inotify: true, intervalMs: 2000 },
      others: [
        port("ttyV0", null),
        port("ttyV1", { equipmentId: "e1", equipmentName: "Equipo C #01", consoleId: "c1", consoleKey: "CONSOLA", consoleLabel: "Consola" }),
      ],
    }
    let d = started(equipoA)
    d = assignPort(d, d.consoles[0].uid, { stableKey: "ttyV0", matchBy: "path" })
    d = assignPort(d, d.consoles[1].uid, { stableKey: "ttyV1", matchBy: "path" })
    const text = (equipment: string, key: string) => `Ese puerto ya está asignado a ${equipment} · ${key}`
    expect(bindingConflicts(d, snapshot, text)).toEqual({ "consoles.1.binding": ["Ese puerto ya está asignado a Equipo C #01 · CONSOLA"] })
    expect(bindingConflicts(assignPort(d, d.consoles[1].uid, { stableKey: "gone", matchBy: "path" }), snapshot, text)).toEqual({})
    expect(bindingConflicts(started(equipoA), snapshot, text)).toEqual({})
  })

  it("names the other slot of the draft that already holds a port, so moving it can say who loses it", () => {
    let d = started(equipoA)
    const [a, b] = d.consoles
    d = assignPort(d, a.uid, { stableKey: "ttyV0", matchBy: "path" })
    expect(portHolder(d, "ttyV0", b.uid)).toBe("UART0")
    expect(portHolder(d, "ttyV0", a.uid)).toBeNull()
    expect(portHolder(d, "ttyV0")).toBe("UART0")
    expect(portHolder(d, "ttyV1", b.uid)).toBeNull()
    expect(portHolder(d, null, b.uid)).toBeNull()
  })

  it("seeds the accesses from the template (cable labels resolved) and sends them with automatic ports", () => {
    const withAcc: TemplateDTO = {
      ...equipoA, id: "tplAcc", spec: {
        ...equipoA.spec,
        accesses: [
          { key: "JTAG0", label: "JTAG 0", kind: "jtag", policy: "reserved", consoleKey: null, targetHost: null, targetPort: null, cableName: "JTAG-07", targetMode: "ip", sshUser: null },
          { key: "SERIE0", label: "Serie 0", kind: "serial", policy: "always", consoleKey: "UART0", targetHost: null, targetPort: null, cableName: null, targetMode: "ip", sshUser: null },
        ],
      },
    }
    const d = applyChoice(emptyDraft(), withAcc.id, [withAcc], [], counter(), (n) => (n === "JTAG-07" ? "210299A1" : null))
    expect(d.accesses.map((a) => [a.key, a.cableSerial, a.consoleKey, a.port, a.policy])).toEqual([["JTAG0", "210299A1", null, null, "reserved"], ["SERIE0", null, "UART0", null, "always"]])
    const { input } = buildCreateInput({ ...d, name: "X", saveToTemplate: true }, withAcc)
    expect(input.accesses?.map((a) => [a.key, a.port, a.cableSerial, a.consoleKey])).toEqual([["JTAG0", null, "210299A1", null], ["SERIE0", null, null, "UART0"]])
    expect(input.templateUpdate?.accesses?.map((a) => [a.key, a.cableName])).toEqual([["JTAG0", "JTAG-07"], ["SERIE0", null]])
    const resolve = (n: string) => (n === "JTAG-07" ? "210299A1" : null)
    expect(choiceLosesWork({ ...d, accesses: d.accesses.slice(1) }, [withAcc], resolve)).toBe(true)
    expect(choiceLosesWork(d, [withAcc], resolve)).toBe(false)
  })
})
