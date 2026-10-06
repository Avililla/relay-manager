import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import type { PrismaClient } from "@/generated/prisma/client"
import { createPrismaClient } from "@/server/db/client"
import { createNullLogger } from "@/server/log"
import type { AuthUser, ReservationChange } from "@/server/runtime/types"
import { createReservationService, TOUCH_THROTTLE_MS, type ReservationServiceInternal } from "./reservations"
import { createTestDb, fakeAudit, fakeBus, fakeSettings, makeUser, testConfig, type TestDb } from "../../../test/helpers"

const T0 = new Date("2026-09-23T10:00:00.000Z")
let db: TestDb
let clock: Date
let bus: ReturnType<typeof fakeBus>
let audit: ReturnType<typeof fakeAudit>
let settings: ReturnType<typeof fakeSettings>
let svc: ReservationServiceInternal
const services: ReservationServiceInternal[] = []

function authUser(u: { id: string; username: string; name: string; isAdmin: boolean; roles?: Array<{ id: string }> }): AuthUser {
  return { id: u.id, username: u.username, name: u.name, isAdmin: u.isAdmin, roleIds: (u.roles ?? []).map((r) => r.id), mustChangePassword: false, sessionVersion: 1 }
}

function make(prisma: PrismaClient = db.prisma): ReservationServiceInternal {
  const s = createReservationService({ config: testConfig(), log: createNullLogger(), prisma, bus, audit, settings, now: () => clock })
  services.push(s)
  return s
}

async function makeEquipment(name: string, roleIds: string[] = []) {
  return db.prisma.equipment.create({ data: { name, roles: roleIds.length ? { connect: roleIds.map((id) => ({ id })) } : undefined } })
}

const min = (n: number) => n * 60_000
const at = (ms: number) => new Date(T0.getTime() + ms).toISOString()
const events = (type: string) => bus.events.filter((e) => e.event.type === type)
const actions = () => audit.inputs.map((i) => i.action)

beforeAll(async () => { db = await createTestDb() })
afterAll(async () => { await db.cleanup() })
beforeEach(async () => {
  clock = new Date(T0)
  bus = fakeBus()
  audit = fakeAudit()
  settings = fakeSettings()
  await db.prisma.equipment.deleteMany({})
  await db.prisma.user.deleteMany({})
  await db.prisma.role.deleteMany({})
  svc = make()
  await svc.start()
})
afterEach(async () => {
  for (const s of services.splice(0)) { s.stop(); await s.idle() }
  vi.useRealTimers()
})

describe("reservation service (§4.11)", () => {
  it("rule 1: start() loads existing reservations into the cache", async () => {
    const u = await makeUser(db.prisma, { name: "Ana" })
    const eq = await db.prisma.equipment.create({
      data: { name: "EQ-1", reservedById: u.id, reservedAt: T0, reservationExpiresAt: new Date(T0.getTime() + min(10)), reservationNote: "boot" },
    })
    const s2 = make()
    await s2.start()
    expect(s2.get(eq.id)).toEqual({
      equipmentId: eq.id, holderId: u.id, holderName: "Ana", holderUsername: u.username,
      reservedAt: T0.toISOString(), expiresAt: at(min(10)), note: "boot",
    })
    expect(s2.isHolder(eq.id, u.id)).toBe(true)
    expect(s2.list()).toHaveLength(1)
  })

  it("rule 2: reserve a free unit sets holder, timestamps and note; audits, publishes and notifies", async () => {
    const u = authUser(await makeUser(db.prisma, { name: "Ana" }))
    const eq = await makeEquipment("EQ-1")
    const changes: ReservationChange[] = []
    svc.onChange((c) => changes.push(c))
    const r = await svc.reserve(eq.id, { ...u, ip: "10.0.0.5" } as AuthUser, { note: "arranque", ip: "10.0.0.5" })
    expect(r).toEqual({ equipmentId: eq.id, holderId: u.id, holderName: "Ana", holderUsername: u.username, reservedAt: T0.toISOString(), expiresAt: at(min(30)), note: "arranque" })
    const row = await db.prisma.equipment.findUniqueOrThrow({ where: { id: eq.id } })
    expect(row.reservedById).toBe(u.id)
    expect(row.reservationExpiresAt?.toISOString()).toBe(at(min(30)))
    expect(row.reservationNote).toBe("arranque")
    expect(audit.inputs[0]).toMatchObject({ action: "reservation.reserve", actor: { kind: "user", id: u.id, ip: "10.0.0.5" }, equipment: { id: eq.id, name: "EQ-1" } })
    expect(events("reservation.changed")[0]).toEqual({
      event: { type: "reservation.changed", equipmentId: eq.id, equipmentName: "EQ-1", reservation: r, cause: "reserve", byName: "Ana", serverNow: T0.toISOString() },
      audience: { kind: "equipment", equipmentId: eq.id },
    })
    expect(changes).toEqual([{ equipmentId: eq.id, before: null, after: r, cause: "reserve", by: expect.objectContaining({ kind: "user", id: u.id }) }])
    expect(svc.isHolder(eq.id, u.id)).toBe(true)
  })

  it("rule 2: two concurrent reserves on a real SQLite file produce exactly one winner", async () => {
    const a = authUser(await makeUser(db.prisma, { name: "Ana" }))
    const b = authUser(await makeUser(db.prisma, { name: "Berta" }))
    const eq = await makeEquipment("EQ-1")
    const results = await Promise.allSettled([svc.reserve(eq.id, a), svc.reserve(eq.id, b)])
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
    const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult
    expect(lost.reason).toMatchObject({ name: "DomainError", code: "RESERVED_BY_OTHER", details: { holderName: expect.any(String), expiresAt: at(min(30)) } })
  })

  it("rule 2: two services on two connections to the same file → exactly one winner", async () => {
    const a = authUser(await makeUser(db.prisma, { name: "Ana" }))
    const b = authUser(await makeUser(db.prisma, { name: "Berta" }))
    const eq = await makeEquipment("EQ-1")
    const second = createPrismaClient(db.dbFile)
    try {
      const other = make(second)
      await other.start()
      const results = await Promise.allSettled([svc.reserve(eq.id, a), other.reserve(eq.id, b)])
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
      const row = await db.prisma.equipment.findUniqueOrThrow({ where: { id: eq.id } })
      const winner = results[0].status === "fulfilled" ? a.id : b.id
      expect(row.reservedById).toBe(winner)
    } finally {
      await second.$disconnect()
    }
  })

  it("rule 2: reserving an expired unit held by someone else first expires the previous holder", async () => {
    const a = authUser(await makeUser(db.prisma, { name: "Ana" }))
    const b = authUser(await makeUser(db.prisma, { name: "Berta" }))
    const eq = await makeEquipment("EQ-1")
    await svc.reserve(eq.id, a)
    clock = new Date(T0.getTime() + min(31))
    bus.events.length = 0
    audit.inputs.length = 0
    const r = await svc.reserve(eq.id, b)
    expect(r.holderId).toBe(b.id)
    expect(actions()).toEqual(["reservation.expire", "reservation.reserve"])
    expect(audit.inputs[0]).toMatchObject({ actor: { kind: "system" }, detail: { previousHolder: a.username } })
    expect(events("reservation.changed").map((e) => e.event.type === "reservation.changed" && e.event.cause)).toEqual(["expire", "reserve"])
  })

  it("rule 3: reserve on an own unit acts as renew and updates the note", async () => {
    const a = authUser(await makeUser(db.prisma, { name: "Ana" }))
    const eq = await makeEquipment("EQ-1")
    await svc.reserve(eq.id, a, { note: "uno" })
    clock = new Date(T0.getTime() + min(10))
    const r = await svc.reserve(eq.id, a, { note: "dos" })
    expect(r.reservedAt).toBe(T0.toISOString())
    expect(r.expiresAt).toBe(at(min(40)))
    expect(r.note).toBe("dos")
    expect(actions()).toEqual(["reservation.reserve", "reservation.renew"])
    expect(events("reservation.changed").at(-1)?.event).toMatchObject({ cause: "renew" })
  })

  it("rule 4: invisible equipment → NOT_FOUND; a disabled user → FORBIDDEN", async () => {
    const role = await db.prisma.role.create({ data: { name: "Integración" } })
    const eq = await makeEquipment("EQ-1", [role.id])
    const outsider = authUser(await makeUser(db.prisma))
    await expect(svc.reserve(eq.id, outsider)).rejects.toMatchObject({ code: "NOT_FOUND" })
    await expect(svc.reserve("doesnotexist", outsider)).rejects.toMatchObject({ code: "NOT_FOUND" })
    const disabled = authUser(await makeUser(db.prisma, { disabled: true, roleIds: [role.id] }))
    await expect(svc.reserve(eq.id, { ...disabled, roleIds: [role.id] })).rejects.toMatchObject({ code: "FORBIDDEN" })
    const member = await makeUser(db.prisma, { roleIds: [role.id] })
    await expect(svc.reserve(eq.id, authUser(member))).resolves.toMatchObject({ holderId: member.id })
  })

  it("rule 5: renew by the holder extends; non-holder → NOT_HOLDER; free → NOT_RESERVED; only 'button' is audited", async () => {
    const a = authUser(await makeUser(db.prisma, { name: "Ana" }))
    const b = authUser(await makeUser(db.prisma))
    const eq = await makeEquipment("EQ-1")
    await expect(svc.renew(eq.id, a, "button")).rejects.toMatchObject({ code: "NOT_RESERVED" })
    await svc.reserve(eq.id, a)
    clock = new Date(T0.getTime() + min(20))
    const r = await svc.renew(eq.id, a, "button")
    expect(r.expiresAt).toBe(at(min(50)))
    await svc.renew(eq.id, a, "console")
    await svc.renew(eq.id, a, "relay")
    await expect(svc.renew(eq.id, b, "button")).rejects.toMatchObject({ code: "NOT_HOLDER" })
    expect(actions()).toEqual(["reservation.reserve", "reservation.renew"])
    expect(events("reservation.changed").map((e) => e.event.type === "reservation.changed" && e.event.cause)).toEqual(["reserve", "renew", "renew", "renew"])
  })

  it("rule 6: touch is a throttled renew (once per 60 s), publishes cause renew and is not audited", async () => {
    const a = authUser(await makeUser(db.prisma, { name: "Ana" }))
    const b = authUser(await makeUser(db.prisma))
    const eq = await makeEquipment("EQ-1")
    await svc.reserve(eq.id, a)
    bus.events.length = 0
    audit.inputs.length = 0
    clock = new Date(T0.getTime() + min(5))
    svc.touch(eq.id, a.id, "console")
    svc.touch(eq.id, a.id, "console")
    await svc.idle()
    expect(events("reservation.changed")).toHaveLength(1)
    expect(events("reservation.changed")[0].event).toMatchObject({ cause: "renew", byName: "Ana", reservation: { expiresAt: at(min(35)) } })
    expect((await db.prisma.equipment.findUniqueOrThrow({ where: { id: eq.id } })).reservationExpiresAt?.toISOString()).toBe(at(min(35)))
    expect(svc.get(eq.id)?.expiresAt).toBe(at(min(35)))
    clock = new Date(T0.getTime() + min(5) + TOUCH_THROTTLE_MS - 1)
    svc.touch(eq.id, a.id, "relay")
    await svc.idle()
    expect(events("reservation.changed")).toHaveLength(1)
    clock = new Date(T0.getTime() + min(5) + TOUCH_THROTTLE_MS)
    svc.touch(eq.id, a.id, "relay")
    svc.touch(eq.id, b.id, "console")
    await svc.idle()
    expect(events("reservation.changed")).toHaveLength(2)
    expect(audit.inputs).toEqual([])
  })

  it("rule 7: release by the holder clears the fields; others get NOT_HOLDER", async () => {
    const a = authUser(await makeUser(db.prisma, { name: "Ana" }))
    const b = authUser(await makeUser(db.prisma))
    const eq = await makeEquipment("EQ-1")
    await expect(svc.release(eq.id, a)).rejects.toMatchObject({ code: "NOT_HOLDER" })
    await svc.reserve(eq.id, a)
    await expect(svc.release(eq.id, b)).rejects.toMatchObject({ code: "NOT_HOLDER" })
    await svc.release(eq.id, a)
    const row = await db.prisma.equipment.findUniqueOrThrow({ where: { id: eq.id } })
    expect([row.reservedById, row.reservedAt, row.reservationExpiresAt, row.reservationNote]).toEqual([null, null, null, null])
    expect(svc.get(eq.id)).toBeNull()
    expect(actions()).toEqual(["reservation.reserve", "reservation.release"])
    expect(events("reservation.changed").at(-1)?.event).toMatchObject({ reservation: null, cause: "release", byName: "Ana" })
  })

  it("rule 8: force release needs an admin, audits the reason and toasts the previous holder", async () => {
    const a = authUser(await makeUser(db.prisma, { name: "Ana" }))
    const admin = authUser(await makeUser(db.prisma, { name: "Jefa", isAdmin: true }))
    const eq = await makeEquipment("EQ-1")
    await svc.reserve(eq.id, a)
    await expect(svc.forceRelease(eq.id, a, "motivo")).rejects.toMatchObject({ code: "FORBIDDEN" })
    await svc.forceRelease(eq.id, admin, "Cambio de firmware")
    expect(svc.get(eq.id)).toBeNull()
    expect(audit.inputs.at(-1)).toMatchObject({ action: "reservation.force-release", actor: { id: admin.id }, detail: { reason: "Cambio de firmware", previousHolder: a.username } })
    expect(events("toast")[0]).toEqual({
      event: { type: "toast", level: "warn", message: "Jefa ha liberado tu reserva de EQ-1: Cambio de firmware" },
      audience: { kind: "user", userId: a.id },
    })
    expect(events("reservation.changed").at(-1)?.event).toMatchObject({ cause: "force-release", byName: "Jefa", reservation: null })
    await expect(svc.forceRelease(eq.id, admin, "otra vez")).rejects.toMatchObject({ code: "NOT_RESERVED" })
  })

  it("rule 9: the sweeper expires reservations every 5 s (fake timers)", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
    const s = make()
    await s.start()
    const a = authUser(await makeUser(db.prisma, { name: "Ana" }))
    const eq = await makeEquipment("EQ-1")
    await s.reserve(eq.id, a)
    audit.inputs.length = 0
    bus.events.length = 0
    clock = new Date(T0.getTime() + min(29))
    await vi.advanceTimersByTimeAsync(5_000)
    await s.idle()
    expect(events("reservation.changed")).toHaveLength(0)
    clock = new Date(T0.getTime() + min(30))
    expect(s.isHolder(eq.id, a.id)).toBe(false)
    await vi.advanceTimersByTimeAsync(5_000)
    await s.idle()
    expect(actions()).toEqual(["reservation.expire"])
    expect(audit.inputs[0]).toMatchObject({ actor: { kind: "system", name: "sistema" }, equipment: { id: eq.id } })
    expect(events("reservation.changed")[0].event).toMatchObject({ cause: "expire", reservation: null, byName: null })
    expect((await db.prisma.equipment.findUniqueOrThrow({ where: { id: eq.id } })).reservedById).toBeNull()
  })

  it("rule 9: every 30 s disabled holders (user-removed) and holders without access (access-lost) are released", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
    const s = make()
    await s.start()
    const role = await db.prisma.role.create({ data: { name: "Integración" } })
    const member = await makeUser(db.prisma, { name: "Ana", roleIds: [role.id] })
    const other = await makeUser(db.prisma, { name: "Berta" })
    const eq1 = await makeEquipment("EQ-1", [role.id])
    const eq2 = await makeEquipment("EQ-2")
    await s.reserve(eq1.id, authUser(member))
    await s.reserve(eq2.id, authUser(other))
    audit.inputs.length = 0
    bus.events.length = 0
    await db.prisma.role.update({ where: { id: role.id }, data: { users: { disconnect: { id: member.id } } } })
    await db.prisma.user.update({ where: { id: other.id }, data: { disabled: true } })
    await vi.advanceTimersByTimeAsync(25_000)
    await s.idle()
    expect(audit.inputs).toEqual([])
    await vi.advanceTimersByTimeAsync(5_000)
    await s.idle()
    expect(s.list()).toEqual([])
    const byEq = new Map(audit.inputs.map((i) => [i.equipment?.id, i]))
    expect(byEq.get(eq1.id)).toMatchObject({ action: "reservation.force-release", actor: { kind: "system" }, detail: { cause: "access-lost" } })
    expect(byEq.get(eq2.id)).toMatchObject({ action: "reservation.force-release", actor: { kind: "system" }, detail: { cause: "user-removed" } })
    const causes = events("reservation.changed").map((e) => e.event.type === "reservation.changed" && e.event.cause).sort()
    expect(causes).toEqual(["access-lost", "user-removed"])
  })

  it("rule 9: rows written outside Prisma (other ISO text format) still expire and can be taken over", async () => {
    const a = await makeUser(db.prisma, { name: "Ana" })
    const b = authUser(await makeUser(db.prisma, { name: "Berta" }))
    const eq1 = await makeEquipment("EQ-1")
    const eq2 = await makeEquipment("EQ-2")
    // As a CLI/sqlite3 would write them: "…Z" instead of Prisma's "…+00:00".
    const upd = 'UPDATE "Equipment" SET "reservedById" = ?, "reservedAt" = ?, "reservationExpiresAt" = ? WHERE "id" = ?'
    await db.prisma.$executeRawUnsafe(upd, a.id, T0.toISOString(), at(min(1)), eq1.id)
    await db.prisma.$executeRawUnsafe(upd, a.id, T0.toISOString(), at(min(1)), eq2.id)
    const s = make()
    await s.start()
    expect(s.isHolder(eq1.id, a.id)).toBe(true)
    clock = new Date(T0.getTime() + min(2))
    await expect(s.reserve(eq2.id, b)).resolves.toMatchObject({ holderId: b.id })
    expect(await s.sweepExpired()).toBe(1)
    expect((await db.prisma.equipment.findUniqueOrThrow({ where: { id: eq1.id } })).reservedById).toBeNull()
    expect(actions().filter((x) => x === "reservation.expire")).toHaveLength(2)
  })

  it("rule 10: releaseAllForUser releases every unit of the user and audits it", async () => {
    const a = authUser(await makeUser(db.prisma, { name: "Ana" }))
    const eq1 = await makeEquipment("EQ-1")
    const eq2 = await makeEquipment("EQ-2")
    await svc.reserve(eq1.id, a)
    await svc.reserve(eq2.id, a)
    audit.inputs.length = 0
    expect(await svc.releaseAllForUser(a.id, "user-disabled")).toBe(2)
    expect(svc.list()).toEqual([])
    expect(audit.inputs.map((i) => [i.action, i.actor.kind, i.detail?.cause, i.detail?.reason])).toEqual([
      ["reservation.force-release", "system", "user-removed", "user-disabled"], ["reservation.force-release", "system", "user-removed", "user-disabled"],
    ])
    expect(events("reservation.changed").slice(-2).map((e) => e.event.type === "reservation.changed" && e.event.cause)).toEqual(["user-removed", "user-removed"])
    expect(await svc.releaseAllForUser(a.id, "user-deleted")).toBe(0)
  })

  it("rule 12: isHolder is synchronous and false once expiresAt has passed, before the sweep", async () => {
    const a = authUser(await makeUser(db.prisma))
    const eq = await makeEquipment("EQ-1")
    expect(svc.isHolder(eq.id, a.id)).toBe(false)
    await svc.reserve(eq.id, a)
    expect(svc.isHolder(eq.id, a.id)).toBe(true)
    expect(svc.isHolder(eq.id, "someone")).toBe(false)
    clock = new Date(T0.getTime() + min(30))
    expect(svc.isHolder(eq.id, a.id)).toBe(false)
    expect(svc.get(eq.id)).toBeNull()
  })

  it("rule 13: the timeout is read from settings at reserve/renew time", async () => {
    const a = authUser(await makeUser(db.prisma))
    const eq = await makeEquipment("EQ-1")
    await settings.update({ reservationTimeoutMin: 10 }, { kind: "system", id: null, name: "sistema" })
    expect((await svc.reserve(eq.id, a)).expiresAt).toBe(at(min(10)))
    await settings.update({ reservationTimeoutMin: 60 }, { kind: "system", id: null, name: "sistema" })
    expect((await svc.renew(eq.id, a, "button")).expiresAt).toBe(at(min(60)))
  })

  it("stop() clears the timers", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
    const s = make()
    await s.start()
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    s.stop()
    expect(vi.getTimerCount()).toBe(0)
  })
})
