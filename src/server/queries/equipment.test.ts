import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import type { ConsoleRuntimeDTO } from "@/lib/contracts/serial"
import { setRuntime } from "@/server/runtime/registry"
import type { AuthUser, Runtime } from "@/server/runtime/types"
import { pathBinding, resetDomainTables, usbBinding } from "@/server/services/test-fixtures"
import { createTestDb, fakeReservations, fakeRuntime, type TestDb } from "../../../test/helpers"
import { getEquipmentActivity, getEquipmentEdit, getEquipmentWorkspace, listEquipmentCards } from "./equipment"
import { getWizardData } from "./wizard"
import { listTemplates } from "./templates"

let db: TestDb
let rt: Runtime
const u = (over: Partial<AuthUser> = {}): AuthUser => ({ id: "u1", username: "ana", name: "Ana", isAdmin: false, roleIds: [], mustChangePassword: false, sessionVersion: 1, ...over })

beforeAll(async () => { db = await createTestDb() })
afterAll(async () => { await db.cleanup() })
beforeEach(async () => {
  await resetDomainTables(db.prisma)
  rt = fakeRuntime({ prisma: db.prisma })
  setRuntime(rt)
})

describe("equipment queries (§7.4)", () => {
  it("listEquipmentCards: visible only, ordered by position then name (numeric), 0 relays are fine", async () => {
    const role = await db.prisma.role.create({ data: { name: "Secreto" } })
    await db.prisma.equipment.create({ data: { name: "Equipo A #10" } })
    await db.prisma.equipment.create({ data: { name: "Equipo A #2", consoles: { create: [{ key: "UART0", label: "UART0", position: 0, ...usbBinding("usb:0403:6011:FT4ABCDE:if1:p0", 1) }] } } })
    await db.prisma.equipment.create({ data: { name: "Oculto", roles: { connect: [{ id: role.id }] } } })
    const cards = await listEquipmentCards(u())
    expect(cards.map((c) => c.name)).toEqual(["Equipo A #2", "Equipo A #10"])
    expect(cards[0].relays).toEqual([])
    expect(cards[0].reservation).toBeNull()
    expect(cards[0].consoles[0]).toMatchObject({
      key: "UART0", matchBy: "adapter", adapterShort: "FT4ABCDE·B", line: { baudRate: 115200, parity: "none" },
      runtime: { status: "opening", viewers: 0 },
    })
    expect((await listEquipmentCards(u({ isAdmin: true }))).map((c) => c.name)).toEqual(["Equipo A #2", "Equipo A #10", "Oculto"])
    expect((await listEquipmentCards(u({ roleIds: [role.id] }))).map((c) => c.name)).toContain("Oculto")
  })

  it("uses the console manager runtime and the reservation service when available", async () => {
    const eq = await db.prisma.equipment.create({ data: { name: "EQ", consoles: { create: [{ key: "UART1", label: "UART1", position: 0, ...pathBinding("/run/relay-manager/sim/ttyV1") }] } } })
    const c = await db.prisma.serialConsole.findFirstOrThrow({ where: { equipmentId: eq.id } })
    const runtime: ConsoleRuntimeDTO = { status: "open", devNode: "/run/relay-manager/sim/ttyV1", detail: null, since: "2026-09-23T10:00:00.000Z", lastRxAt: null, lastLine: "login:", viewers: 2, released: null, capture: "active" }
    rt.serial.consoles.runtimeForEquipment = (id) => (id === eq.id ? { [c.id]: runtime } : {})
    rt.reservations = fakeReservations({ holders: { [eq.id]: "u9" } })
    const ws = await getEquipmentWorkspace(u(), eq.id)
    expect(ws?.consoles[0]).toMatchObject({ adapterShort: "ttyV1", runtime, binding: { matchBy: "path", devicePath: "/run/relay-manager/sim/ttyV1" }, hupcl: false, captureToDisk: true })
    expect(ws?.reservation?.holderId).toBe("u9")
    expect(ws?.reservationWarningMin).toBe(5)
  })

  it("workspace/activity of invisible equipment → null / NOT_FOUND; edit is admin-only", async () => {
    const role = await db.prisma.role.create({ data: { name: "Secreto" } })
    const eq = await db.prisma.equipment.create({ data: { name: "Oculto", roles: { connect: [{ id: role.id }] } } })
    expect(await getEquipmentWorkspace(u(), eq.id)).toBeNull()
    await expect(getEquipmentActivity(u(), eq.id, null)).rejects.toMatchObject({ code: "NOT_FOUND" })
    expect(await getEquipmentEdit(u(), eq.id)).toBeNull()
    const edit = await getEquipmentEdit(u({ isAdmin: true }), eq.id)
    expect(edit).toMatchObject({ id: eq.id, roleIds: [role.id], roles: [{ id: role.id, name: "Secreto" }], boards: [], hideJtag: true, serialHints: [] })
  })

  it("getWizardData: templates, roles, board choices with 0 boards, existing names; admin only", async () => {
    await db.prisma.equipmentTemplate.create({ data: { key: "equipo-a", name: "Equipo A", source: "file", needsReview: true, spec: { version: 1, consoles: [], relays: [] } } })
    // A retired template is never offered to new equipment.
    await db.prisma.equipmentTemplate.create({ data: { key: "equipo-z", name: "Equipo Z", source: "file", retiredAt: new Date(), spec: { version: 1, consoles: [], relays: [] } } })
    await db.prisma.equipment.create({ data: { name: "Equipo A #01" } })
    const w = await getWizardData(u({ isAdmin: true }))
    expect(w.templates.map((t) => [t.name, t.needsReview, t.equipmentCount])).toEqual([["Equipo A", true, 0]])
    expect(w.boards).toEqual([])
    expect(w.existingNames).toEqual(["Equipo A #01"])
    await expect(getWizardData(u())).rejects.toMatchObject({ code: "FORBIDDEN" })
    expect((await listTemplates())[0].spec.namePattern).toBe("{template} #{nn}")
  })
})
