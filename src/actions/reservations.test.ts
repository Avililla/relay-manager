import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { createNullLogger } from "@/server/log"
import { setRuntime } from "@/server/runtime/registry"
import type { AuthUser } from "@/server/runtime/types"
import { createReservationService, type ReservationServiceInternal } from "@/server/services/reservations"
import { createTestDb, fakeAudit, fakeBus, fakeRuntime, fakeSettings, makeUser, testConfig, type TestDb } from "../../test/helpers"
import { forceReleaseReservation, releaseReservation, renewReservation, reserveEquipment } from "./reservations"

const state = vi.hoisted(() => ({ user: null as AuthUser | null }))
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-forwarded-for": "10.0.0.42" }) }))
vi.mock("next/cache", () => ({ revalidatePath: () => {} }))
vi.mock("@/server/authz", () => ({ getAuthUser: async () => state.user }))

let db: TestDb
let audit: ReturnType<typeof fakeAudit>
let bus: ReturnType<typeof fakeBus>
let reservations: ReservationServiceInternal
let ana: AuthUser
let berta: AuthUser
let jefa: AuthUser
let eqId: string

const asAuth = (u: { id: string; username: string; name: string; isAdmin: boolean }): AuthUser =>
  ({ id: u.id, username: u.username, name: u.name, isAdmin: u.isAdmin, roleIds: [], mustChangePassword: false, sessionVersion: 1 })

beforeAll(async () => { db = await createTestDb() })
afterAll(async () => { await db.cleanup() })
beforeEach(async () => {
  await db.prisma.equipment.deleteMany({})
  await db.prisma.user.deleteMany({})
  audit = fakeAudit()
  bus = fakeBus()
  const settings = fakeSettings()
  reservations = createReservationService({ config: testConfig(), log: createNullLogger(), prisma: db.prisma, bus, audit, settings })
  setRuntime(fakeRuntime({ prisma: db.prisma, audit, bus, settings, reservations }))
  ana = asAuth(await makeUser(db.prisma, { name: "Ana" }))
  berta = asAuth(await makeUser(db.prisma, { name: "Berta" }))
  jefa = asAuth(await makeUser(db.prisma, { name: "Jefa", isAdmin: true }))
  eqId = (await db.prisma.equipment.create({ data: { name: "Equipo A #01" } })).id
})

describe("reservation actions (§7.2)", () => {
  it("reserve → renew → release, with the socket IP in every audit row", async () => {
    state.user = ana
    const r = await reserveEquipment({ equipmentId: eqId })
    expect(r).toMatchObject({ ok: true, data: { holderId: ana.id, note: null } })
    expect(await renewReservation({ equipmentId: eqId })).toMatchObject({ ok: true, data: { holderId: ana.id } })
    expect(await releaseReservation({ equipmentId: eqId })).toEqual({ ok: true, data: null })
    expect(audit.inputs.map((i) => [i.action, i.actor.ip])).toEqual([
      ["reservation.reserve", "10.0.0.42"], ["reservation.renew", "10.0.0.42"], ["reservation.release", "10.0.0.42"],
    ])
  })

  it("RESERVED_BY_OTHER and NOT_HOLDER are returned with details and audited as denied", async () => {
    state.user = ana
    await reserveEquipment({ equipmentId: eqId, note: "arranque" })
    state.user = berta
    const r = await reserveEquipment({ equipmentId: eqId })
    expect(r).toMatchObject({ ok: false, error: { code: "RESERVED_BY_OTHER", details: { holderName: "Ana" } } })
    expect(r.ok ? "" : r.error.message).toContain("Ana")
    expect(await releaseReservation({ equipmentId: eqId })).toMatchObject({ ok: false, error: { code: "NOT_HOLDER" } })
    expect(audit.inputs.filter((i) => i.outcome === "denied").map((i) => i.action)).toEqual(["reservation.reserve", "reservation.release"])
  })

  it("force release is admin-only (auth.denied for others) and requires a reason", async () => {
    state.user = ana
    await reserveEquipment({ equipmentId: eqId })
    state.user = berta
    expect(await forceReleaseReservation({ equipmentId: eqId, reason: "urgente" })).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } })
    expect(audit.inputs.at(-1)).toMatchObject({ action: "auth.denied", outcome: "denied" })
    state.user = jefa
    expect(await forceReleaseReservation({ equipmentId: eqId, reason: "" })).toMatchObject({ ok: false, error: { code: "VALIDATION", fieldErrors: { reason: [expect.any(String)] } } })
    expect(await forceReleaseReservation({ equipmentId: eqId, reason: "Cambio de firmware" })).toEqual({ ok: true, data: null })
    expect(reservations.get(eqId)).toBeNull()
    expect(bus.events.some((e) => e.event.type === "toast" && e.audience.kind === "user" && e.audience.userId === ana.id)).toBe(true)
    // Then the admin reserves for themself (the "Reservar para mí a continuación" flow).
    expect(await reserveEquipment({ equipmentId: eqId })).toMatchObject({ ok: true, data: { holderId: jefa.id } })
  })
})
