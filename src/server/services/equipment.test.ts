import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { CreateEquipmentInputSchema, UpdateEquipmentInputSchema, type CreateEquipmentInput } from "@/lib/contracts/equipment"
import { DEFAULT_LINE } from "@/lib/contracts/enums"
import { TemplateSpecSchema } from "@/lib/contracts/templates"
import type { AuthUser } from "@/server/runtime/types"
import { fakeReservations, makeUser, createTestDb, type TestDb } from "../../../test/helpers"
import { createEquipment, deleteEquipment, reorderEquipment, updateEquipment, updateEquipmentBindings } from "./equipment"
import { ctxFor, fakeDomain, resetDomainTables, toAuthUser, usbBinding, type FakeDomain } from "./test-fixtures"

let db: TestDb
let fx: FakeDomain
let admin: AuthUser
let reservations: ReturnType<typeof fakeReservations>

beforeAll(async () => { db = await createTestDb() })
afterAll(async () => { await db.cleanup() })
beforeEach(async () => {
  await resetDomainTables(db.prisma)
  reservations = fakeReservations()
  fx = fakeDomain(db.prisma, { reservations })
  admin = toAuthUser(await makeUser(db.prisma, { name: "Admin", isAdmin: true }))
  for (let i = 0; i < 4; i++) fx.devices.set(`usb:0403:6011:FT4ABCDE:if${i}:p0`, usbBinding(`usb:0403:6011:FT4ABCDE:if${i}:p0`, i))
})

/** A keyed local template with values to review (like a 2.x predefined one, or an imported one). */
const equipoA = TemplateSpecSchema.parse({
  version: 1, namePattern: "Equipo A #{nn}", skipInterfaces: [],
  consoles: [
    { key: "UART0", label: "UART0", line: { ...DEFAULT_LINE }, identify: { hostnameRegex: "uart0" } },
    { key: "UART1", label: "UART1", line: { ...DEFAULT_LINE }, identify: { hostnameRegex: "uart1" } },
  ],
  relays: [],
  accesses: [
    { key: "JTAG0", label: "JTAG 0", kind: "jtag" }, { key: "JTAG1", label: "JTAG 1", kind: "jtag" },
    { key: "SERIE0", label: "Serie 0", kind: "serial", consoleKey: "UART0" }, { key: "SERIE1", label: "Serie 1", kind: "serial", consoleKey: "UART1" },
    { key: "ETH", label: "Ethernet", kind: "tcp", targetPort: 22, sshUser: "root" },
  ],
})
async function seedTemplate(source: "local" | "file" = "local") {
  return db.prisma.equipmentTemplate.create({
    data: { key: "equipo-a", name: "Equipo A", description: "Valores provisionales", source, sourceFile: source === "file" ? "plantillas/equipo-a.json" : null, needsReview: true, position: 0, spec: equipoA },
  })
}
async function seedBoard(name = "Placa 1", relayCount = 8) {
  return db.prisma.relayBoard.create({ data: { name, driver: "devantech-ds-ascii", host: `10.0.0.${Math.floor(Math.random() * 200) + 20}`, relayCount } })
}
const sk = (i: number) => `usb:0403:6011:FT4ABCDE:if${i}:p0`
const consoleIn = (key: string, binding: CreateEquipmentInput["consoles"][number]["binding"] = null) => ({
  key, label: key, line: { ...DEFAULT_LINE }, enterMode: "cr" as const, localEcho: false, hupcl: false, captureToDisk: true, identify: {}, binding,
})
function createInput(over: Partial<Record<keyof CreateEquipmentInput, unknown>> = {}): CreateEquipmentInput {
  return CreateEquipmentInputSchema.parse({
    name: "Equipo A #01", serialNumber: "EA-0001", description: null, roleIds: [], templateId: null,
    consoles: [consoleIn("UART0", { stableKey: sk(0), matchBy: "adapter" }), consoleIn("UART1", { stableKey: sk(1), matchBy: "adapter" })],
    relays: [], templateUpdate: null, ...over,
  })
}

describe("createEquipment (§4.15)", () => {
  it("creates the unit with consoles in order, bindings from discovery, relays; then reloads, publishes and audits", async () => {
    const tpl = await seedTemplate()
    const board = await seedBoard()
    const role = await db.prisma.role.create({ data: { name: "Integración" } })
    const r = await createEquipment(createInput({
      templateId: tpl.id, roleIds: [role.id],
      relays: [{ key: "POWER", label: "Alimentación", purpose: "power", requireConfirm: true, defaultPulseMs: null, boardId: board.id, channel: 1 }],
    }), ctxFor(fx.deps, admin))
    const eq = await db.prisma.equipment.findUniqueOrThrow({
      where: { id: r.id }, include: { consoles: { orderBy: { position: "asc" } }, relays: true, roles: true },
    })
    expect(eq.templateId).toBe(tpl.id)
    expect(eq.templateName).toBe("Equipo A")
    expect(eq.roles.map((x) => x.id)).toEqual([role.id])
    expect(eq.consoles.map((c) => [c.position, c.key, c.bindingKey, c.matchBy, c.usbInterface, c.adapterLabel])).toEqual([
      [0, "UART0", sk(0), "adapter", 0, "FTDI Quad RS232-HS (FT4ABCDE) · A"],
      [1, "UART1", sk(1), "adapter", 1, "FTDI Quad RS232-HS (FT4ABCDE) · B"],
    ])
    expect(eq.relays.map((x) => [x.position, x.key, x.boardId, x.channel, x.purpose, x.requireConfirm])).toEqual([[0, "POWER", board.id, 1, "power", true]])
    expect(fx.reloadedEquipment).toEqual([r.id])
    expect(fx.relayReloads.count).toBe(1)
    expect(fx.bus.events.map((e) => e.event)).toEqual([{ type: "equipment.changed", equipmentId: r.id, change: "created" }])
    expect(fx.audit.inputs.map((i) => i.action)).toEqual(["equipment.create"])
    expect(fx.audit.inputs[0]).toMatchObject({ actor: { id: admin.id, ip: "10.0.0.7" }, equipment: { id: r.id, name: "Equipo A #01" }, detail: { template: "Equipo A", consoles: ["UART0", "UART1"], relays: 1 } })
    // The template is untouched without templateUpdate.
    expect((await db.prisma.equipmentTemplate.findUniqueOrThrow({ where: { id: tpl.id } })).needsReview).toBe(true)
  })

  it("equipment with 0 consoles and 0 relays is first-class", async () => {
    const r = await createEquipment(createInput({ name: "Vacío", consoles: [] }), ctxFor(fx.deps, admin))
    expect(await db.prisma.equipment.count({ where: { id: r.id } })).toBe(1)
  })

  it("DEVICE_NOT_FOUND with fieldErrors consoles.<i>.binding when discovery does not see the port", async () => {
    fx.devices.delete(sk(1))
    await expect(createEquipment(createInput(), ctxFor(fx.deps, admin))).rejects.toMatchObject({
      code: "DEVICE_NOT_FOUND", fieldErrors: { "consoles.1.binding": [expect.any(String)] },
    })
    expect(await db.prisma.equipment.count()).toBe(0)
  })

  it("DEVICE_ALREADY_BOUND when another console already holds the binding", async () => {
    await createEquipment(createInput(), ctxFor(fx.deps, admin))
    const again = createInput({ name: "Equipo A #02", consoles: [consoleIn("CONSOLA", { stableKey: sk(1), matchBy: "adapter" })] })
    await expect(createEquipment(again, ctxFor(fx.deps, admin))).rejects.toMatchObject({
      code: "DEVICE_ALREADY_BOUND", fieldErrors: { "consoles.0.binding": [expect.stringContaining("Equipo A #01 · UART1")] },
    })
  })

  it("channel CONFLICT: «El canal N de la placa X ya está asignado»", async () => {
    const board = await seedBoard("Placa A")
    const relay = { key: "POWER", label: "Alimentación", purpose: "power", requireConfirm: false, defaultPulseMs: null, boardId: board.id, channel: 3 }
    await createEquipment(createInput({ consoles: [], relays: [relay] }), ctxFor(fx.deps, admin))
    await expect(createEquipment(createInput({ name: "Otro", consoles: [], relays: [relay] }), ctxFor(fx.deps, admin))).rejects.toMatchObject({
      code: "CONFLICT", fieldErrors: { "relays.0.channel": [expect.stringContaining("El canal 3 de la placa Placa A ya está asignado")] },
    })
    await expect(createEquipment(createInput({ name: "Fuera", consoles: [], relays: [{ ...relay, channel: 9 }] }), ctxFor(fx.deps, admin)))
      .rejects.toMatchObject({ code: "VALIDATION", fieldErrors: { "relays.0.channel": [expect.any(String)] } })
  })

  it("the name is unique (case-insensitive) and roles/templates must exist", async () => {
    await createEquipment(createInput({ consoles: [] }), ctxFor(fx.deps, admin))
    await expect(createEquipment(createInput({ name: "equipo a #01", consoles: [] }), ctxFor(fx.deps, admin)))
      .rejects.toMatchObject({ code: "CONFLICT", fieldErrors: { name: [expect.any(String)] } })
    await expect(createEquipment(createInput({ name: "X", consoles: [], roleIds: ["nope"] }), ctxFor(fx.deps, admin)))
      .rejects.toMatchObject({ code: "VALIDATION", fieldErrors: { roleIds: [expect.any(String)] } })
    await expect(createEquipment(createInput({ name: "Y", consoles: [], templateId: "nope" }), ctxFor(fx.deps, admin)))
      .rejects.toMatchObject({ code: "VALIDATION", fieldErrors: { templateId: [expect.any(String)] } })
  })

  it("templateUpdate writes the slot draft back, keeps relay slots without a board and never writes equipment-only fields", async () => {
    const tpl = await seedTemplate()
    const board = await seedBoard()
    const draftConsoles = [
      { key: "UART0", label: "UART0", line: { ...DEFAULT_LINE }, enterMode: "cr", localEcho: false, identify: { hostnameRegex: "uart0" } },
      { key: "UART1", label: "UART1", line: { ...DEFAULT_LINE }, enterMode: "cr", localEcho: false, identify: {} },
      { key: "AUX", label: "Auxiliar", line: { ...DEFAULT_LINE, baudRate: 9600 }, enterMode: "crlf", localEcho: true, identify: {} },
    ]
    const draftRelays = [
      { key: "POWER", label: "Alimentación", purpose: "power", requireConfirm: true, defaultPulseMs: null },
      { key: "RESET", label: "Reset", purpose: "reset", requireConfirm: false, defaultPulseMs: 500 },
    ]
    const input = createInput({
      templateId: tpl.id,
      consoles: [
        { ...consoleIn("UART0", { stableKey: sk(0), matchBy: "adapter" }), hupcl: true, captureToDisk: false },
        consoleIn("UART1", { stableKey: sk(1), matchBy: "adapter" }),
        { ...consoleIn("AUX"), label: "Auxiliar", line: { ...DEFAULT_LINE, baudRate: 9600 }, enterMode: "crlf", localEcho: true },
      ],
      // Only POWER got a board; RESET was skipped for lack of a free channel.
      relays: [{ key: "POWER", label: "Alimentación", purpose: "power", requireConfirm: true, defaultPulseMs: null, boardId: board.id, channel: 1 }],
      templateUpdate: { consoles: draftConsoles, relays: draftRelays },
    })
    const r = await createEquipment(input, ctxFor(fx.deps, admin))
    const t = await db.prisma.equipmentTemplate.findUniqueOrThrow({ where: { id: tpl.id } })
    expect(t.needsReview).toBe(false)
    const spec = TemplateSpecSchema.parse(t.spec)
    expect(spec.namePattern).toBe("Equipo A #{nn}")
    expect(spec.consoles.map((c) => c.key)).toEqual(["UART0", "UART1", "AUX"])
    expect(spec.relays.map((x) => x.key)).toEqual(["POWER", "RESET"])
    const raw = JSON.stringify(t.spec)
    for (const forbidden of ["hupcl", "captureToDisk", "binding", "stableKey", "boardId", "channel"]) expect(raw).not.toContain(forbidden)
    expect(fx.audit.inputs.find((i) => i.action === "template.update")).toMatchObject({ detail: { source: "wizard", equipmentId: r.id }, target: { type: "template", id: tpl.id } })
  })

  it("templateUpdate on a template defined in a profile file → VALIDATION (they are read-only)", async () => {
    const tpl = await seedTemplate("file")
    const input = createInput({ templateId: tpl.id, templateUpdate: { consoles: [], relays: [] } })
    await expect(createEquipment(input, ctxFor(fx.deps, admin))).rejects.toMatchObject({ code: "VALIDATION", fieldErrors: { templateUpdate: [expect.stringMatching(/plantillas\/equipo-a\.json/)] } })
  })

  it("templateUpdate without templateId → VALIDATION", async () => {
    const input = createInput({ templateUpdate: { consoles: [], relays: [] } })
    await expect(createEquipment(input, ctxFor(fx.deps, admin))).rejects.toMatchObject({ code: "VALIDATION", fieldErrors: { templateUpdate: [expect.any(String)] } })
  })
})

describe("updateEquipment (§4.15)", () => {
  it("diffs by id: adds, removes and reorders consoles and swaps relay channels without unique collisions", async () => {
    const board = await seedBoard()
    const { id } = await createEquipment(createInput({
      consoles: [consoleIn("UART0", { stableKey: sk(0), matchBy: "adapter" }), consoleIn("UART1", { stableKey: sk(1), matchBy: "adapter" }), consoleIn("OLD")],
      relays: [
        { key: "POWER", label: "Alimentación", purpose: "power", requireConfirm: false, defaultPulseMs: null, boardId: board.id, channel: 1 },
        { key: "RESET", label: "Reset", purpose: "reset", requireConfirm: false, defaultPulseMs: null, boardId: board.id, channel: 2 },
      ],
    }), ctxFor(fx.deps, admin))
    const before = await db.prisma.equipment.findUniqueOrThrow({ where: { id }, include: { consoles: { orderBy: { position: "asc" } }, relays: { orderBy: { position: "asc" } } } })
    const [uart0, uart1] = before.consoles
    const [power, reset] = before.relays
    fx.bus.events.length = 0
    fx.audit.inputs.length = 0
    fx.reloadedEquipment.length = 0
    // Swap UART0/UART1 keys and positions, drop OLD, add NEW, rebind UART1→if2 and unbind UART0; swap relay channels.
    const input = UpdateEquipmentInputSchema.parse({
      equipmentId: id, name: "Equipo A #01 bis", serialNumber: null, description: "banco 2", roleIds: [],
      consoles: [
        { ...consoleIn("UART0", { stableKey: sk(2), matchBy: "adapter" }), id: uart1.id },
        { ...consoleIn("UART1", null), id: uart0.id },
        consoleIn("NEW", { stableKey: sk(3), matchBy: "usb-port" }),
      ],
      relays: [
        { id: reset.id, key: "RESET", label: "Reset", purpose: "reset", requireConfirm: false, defaultPulseMs: null, boardId: board.id, channel: 1 },
        { id: power.id, key: "POWER", label: "Alimentación", purpose: "power", requireConfirm: true, defaultPulseMs: null, boardId: board.id, channel: 2 },
      ],
    })
    await updateEquipment(input, ctxFor(fx.deps, admin))
    const after = await db.prisma.equipment.findUniqueOrThrow({ where: { id }, include: { consoles: { orderBy: { position: "asc" } }, relays: { orderBy: { position: "asc" } } } })
    expect(after.name).toBe("Equipo A #01 bis")
    expect(after.consoles.map((c) => [c.id, c.key, c.position, c.bindingKey, c.matchBy])).toEqual([
      [uart1.id, "UART0", 0, sk(2), "adapter"],
      [uart0.id, "UART1", 1, null, null],
      [expect.any(String), "NEW", 2, sk(3), "usb-port"],
    ])
    expect(after.relays.map((x) => [x.id, x.channel, x.position, x.requireConfirm])).toEqual([[reset.id, 1, 0, false], [power.id, 2, 1, true]])
    expect(fx.reloadedEquipment).toEqual([id])
    expect(fx.bus.events.map((e) => e.event)).toEqual([{ type: "equipment.changed", equipmentId: id, change: "updated" }])
    const audit = fx.audit.inputs.find((i) => i.action === "equipment.update")
    expect(audit?.detail).toMatchObject({ name: ["Equipo A #01", "Equipo A #01 bis"], consoles: { added: ["NEW"], removed: ["OLD"] } })
  })

  it("binding 'keep' keeps the current columns; a console id from another equipment is refused", async () => {
    const a = await createEquipment(createInput(), ctxFor(fx.deps, admin))
    const b = await createEquipment(createInput({ name: "Otro", consoles: [consoleIn("CONSOLA")] }), ctxFor(fx.deps, admin))
    const aConsoles = await db.prisma.serialConsole.findMany({ where: { equipmentId: a.id }, orderBy: { position: "asc" } })
    const bConsole = await db.prisma.serialConsole.findFirstOrThrow({ where: { equipmentId: b.id } })
    fx.devices.clear() // "keep" must not need discovery
    await updateEquipment(UpdateEquipmentInputSchema.parse({
      equipmentId: a.id, name: "Equipo A #01", serialNumber: null, description: null, roleIds: [],
      consoles: aConsoles.map((c) => ({ ...consoleIn(c.key, "keep"), id: c.id, label: `${c.key} (renombrada)` })), relays: [],
    }), ctxFor(fx.deps, admin))
    const kept = await db.prisma.serialConsole.findMany({ where: { equipmentId: a.id }, orderBy: { position: "asc" } })
    expect(kept.map((c) => [c.label, c.bindingKey])).toEqual([["UART0 (renombrada)", sk(0)], ["UART1 (renombrada)", sk(1)]])
    await expect(updateEquipment(UpdateEquipmentInputSchema.parse({
      equipmentId: a.id, name: "Equipo A #01", serialNumber: null, description: null, roleIds: [],
      consoles: [{ ...consoleIn("CONSOLA", "keep"), id: bConsole.id }], relays: [],
    }), ctxFor(fx.deps, admin))).rejects.toMatchObject({ code: "VALIDATION", fieldErrors: { "consoles.0.id": [expect.any(String)] } })
  })

  it("moving a port from one console to another in the same save does not collide", async () => {
    const { id } = await createEquipment(createInput(), ctxFor(fx.deps, admin))
    const cs = await db.prisma.serialConsole.findMany({ where: { equipmentId: id }, orderBy: { position: "asc" } })
    await updateEquipment(UpdateEquipmentInputSchema.parse({
      equipmentId: id, name: "Equipo A #01", serialNumber: null, description: null, roleIds: [],
      consoles: [
        { ...consoleIn("UART0", { stableKey: sk(1), matchBy: "adapter" }), id: cs[0].id },
        { ...consoleIn("UART1", { stableKey: sk(0), matchBy: "adapter" }), id: cs[1].id },
      ],
      relays: [],
    }), ctxFor(fx.deps, admin))
    const after = await db.prisma.serialConsole.findMany({ where: { equipmentId: id }, orderBy: { position: "asc" } })
    expect(after.map((c) => c.bindingKey)).toEqual([sk(1), sk(0)])
  })
})

describe("updateEquipmentBindings and deleteEquipment (§4.15)", () => {
  it("updateEquipmentBindings binds and unbinds, audits equipment.bindings with a diff", async () => {
    const { id } = await createEquipment(createInput({ consoles: [consoleIn("UART0"), consoleIn("UART1", { stableKey: sk(1), matchBy: "adapter" })] }), ctxFor(fx.deps, admin))
    const cs = await db.prisma.serialConsole.findMany({ where: { equipmentId: id }, orderBy: { position: "asc" } })
    fx.audit.inputs.length = 0
    await updateEquipmentBindings({ equipmentId: id, bindings: [
      { consoleId: cs[0].id, binding: { stableKey: sk(0), matchBy: "adapter" } },
      { consoleId: cs[1].id, binding: null },
    ] }, ctxFor(fx.deps, admin))
    const after = await db.prisma.serialConsole.findMany({ where: { equipmentId: id }, orderBy: { position: "asc" } })
    expect(after.map((c) => c.bindingKey)).toEqual([sk(0), null])
    expect(after[1].usbSerial).toBeNull()
    expect(fx.audit.inputs[0]).toMatchObject({ action: "equipment.bindings", equipment: { id } })
    expect(fx.audit.inputs[0].detail).toMatchObject({ changes: [{ key: "UART0", after: sk(0) }, { key: "UART1", before: sk(1), after: null }] })
  })

  it("updateEquipmentBindings files a port held by a sibling console under that binding field, naming the sibling", async () => {
    const { id } = await createEquipment(createInput({ consoles: [consoleIn("UART0"), consoleIn("UART1", { stableKey: sk(1), matchBy: "adapter" })] }), ctxFor(fx.deps, admin))
    const cs = await db.prisma.serialConsole.findMany({ where: { equipmentId: id }, orderBy: { position: "asc" } })
    const err = await updateEquipmentBindings({ equipmentId: id, bindings: [
      { consoleId: cs[0].id, binding: { stableKey: sk(1), matchBy: "adapter" } },
    ] }, ctxFor(fx.deps, admin)).then(() => null, (e: unknown) => e)
    expect(err).toMatchObject({ code: "DEVICE_ALREADY_BOUND", fieldErrors: { "bindings.0.binding": ["Ese puerto ya lo usa la consola UART1 de este equipo"] } })
    expect((err as { fieldErrors: Record<string, string[]> }).fieldErrors._form).toBeUndefined()
    const after = await db.prisma.serialConsole.findMany({ where: { equipmentId: id }, orderBy: { position: "asc" } })
    expect(after.map((c) => c.bindingKey)).toEqual([null, sk(1)])
  })

  it("delete checks the typed name, refuses while another user holds the reservation, and cascades", async () => {
    const { id } = await createEquipment(createInput(), ctxFor(fx.deps, admin))
    await expect(deleteEquipment({ equipmentId: id, confirmName: "equipo a #01" }, ctxFor(fx.deps, admin)))
      .rejects.toMatchObject({ code: "VALIDATION", fieldErrors: { confirmName: [expect.any(String)] } })
    reservations.holders.set(id, "someone-else")
    await expect(deleteEquipment({ equipmentId: id, confirmName: "Equipo A #01" }, ctxFor(fx.deps, admin)))
      .rejects.toMatchObject({ code: "RESERVED_BY_OTHER" })
    reservations.holders.set(id, admin.id)
    await deleteEquipment({ equipmentId: id, confirmName: "Equipo A #01" }, ctxFor(fx.deps, admin))
    expect(reservations.holders.has(id)).toBe(false)
    expect(await db.prisma.serialConsole.count({ where: { equipmentId: id } })).toBe(0)
    expect(fx.bus.events.at(-1)?.event).toEqual({ type: "equipment.changed", equipmentId: id, change: "deleted" })
    expect(fx.audit.inputs.at(-1)).toMatchObject({ action: "equipment.delete", equipment: { id, name: "Equipo A #01" } })
    await expect(deleteEquipment({ equipmentId: id, confirmName: "Equipo A #01" }, ctxFor(fx.deps, admin))).rejects.toMatchObject({ code: "NOT_FOUND" })
  })

  it("reorderEquipment rewrites positions (P2)", async () => {
    const a = await createEquipment(createInput({ name: "A", consoles: [] }), ctxFor(fx.deps, admin))
    const b = await createEquipment(createInput({ name: "B", consoles: [] }), ctxFor(fx.deps, admin))
    await reorderEquipment({ equipmentIds: [b.id, a.id] }, ctxFor(fx.deps, admin))
    const rows = await db.prisma.equipment.findMany({ orderBy: { position: "asc" }, select: { id: true } })
    expect(rows.map((r) => r.id)).toEqual([b.id, a.id])
  })
})
