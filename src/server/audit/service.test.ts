import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { createAuditService, limitDetail, redactDetail } from "./service"
import { createNullLogger, type Logger } from "@/server/log"
import type { PrismaClient } from "@/generated/prisma/client"
import type { AuditService } from "@/server/runtime/types"
import { createTestDb, type TestDb } from "../../../test/helpers"

let db: TestDb
let audit: AuditService
beforeAll(async () => {
  db = await createTestDb()
  await db.prisma.settings.upsert({ where: { id: "global" }, create: {}, update: {} })
  audit = createAuditService({ prisma: db.prisma, log: createNullLogger() })
})
afterAll(async () => { await db.cleanup() })

describe("redaction", () => {
  it("hides pass/secret/token/authorization/cookie/hash keys at any depth", () => {
    const out = redactDetail({
      username: "ana", password: "x", newPassword: "y",
      nested: { apiToken: "t", list: [{ Authorization: "Bearer z", ok: 1 }], clientSecret: { deep: 1 } },
      Cookie: "c", passwordHash: "$2b$", setupTokenFile: "/x", fine: [1, "a", null],
    })
    expect(out).toEqual({
      username: "ana", password: "[oculto]", newPassword: "[oculto]",
      nested: { apiToken: "[oculto]", list: [{ Authorization: "[oculto]", ok: 1 }], clientSecret: "[oculto]" },
      Cookie: "[oculto]", passwordHash: "[oculto]", setupTokenFile: "[oculto]", fine: [1, "a", null],
    })
  })
  it("redacts before the 8 KB size cap", () => {
    const big = { password: "p".repeat(10_000), user: "ana" }
    const d = limitDetail(redactDetail(big))
    expect(d).toEqual({ password: "[oculto]", user: "ana" })
    expect(limitDetail({ blob: "x".repeat(9000) })).toEqual({ truncated: true })
  })
})

describe("audit service", () => {
  it("record is fire-and-forget; flush drains; the row carries ip, equipment and target", async () => {
    audit.record({
      actor: { kind: "user", id: "u1", name: "ana", ip: "10.0.0.5" }, action: "reservation.reserve",
      equipment: { id: "e1", name: "Equipo A #01" }, target: { type: "equipment", id: "e1", name: "Equipo A #01" },
      detail: { note: "x", token: "secreto" },
    })
    await audit.flush()
    const row = await db.prisma.auditEvent.findFirstOrThrow({ where: { action: "reservation.reserve" } })
    expect(row).toMatchObject({ actorKind: "user", actorId: "u1", actorName: "ana", ip: "10.0.0.5", outcome: "ok", equipmentId: "e1", equipmentName: "Equipo A #01", targetType: "equipment" })
    expect(row.detail).toEqual({ note: "x", token: "[oculto]" })
  })

  it("recordNow awaits the write", async () => {
    await audit.recordNow({ actor: { kind: "cli", id: null, name: "cli" }, action: "user.create", outcome: "ok", target: { type: "user", name: "luis" } })
    expect(await db.prisma.auditEvent.count({ where: { action: "user.create" } })).toBe(1)
  })

  it("never throws into callers; drops the event after 3 retries and logs an error", async () => {
    vi.useFakeTimers()
    try {
      const error = vi.fn()
      const log = { ...createNullLogger(), error, child: () => log } as unknown as Logger
      const create = vi.fn(async () => { throw new Error("disk full") })
      const failing = { auditEvent: { create } } as unknown as PrismaClient
      const svc = createAuditService({ prisma: failing, log })
      expect(() => svc.record({ actor: { kind: "system", id: null, name: "sistema" }, action: "system.start" })).not.toThrow()
      const flushed = svc.flush()
      await vi.advanceTimersByTimeAsync(1000)
      await flushed
      expect(create).toHaveBeenCalledTimes(4)
      expect(error).toHaveBeenCalled()
      const now = svc.recordNow({ actor: { kind: "system", id: null, name: "sistema" }, action: "system.stop" }).then(() => "ok", () => "threw")
      await vi.advanceTimersByTimeAsync(1000)
      expect(await now).toBe("ok")
    } finally {
      vi.useRealTimers()
    }
  })

  it("query pages by id cursor descending and filters", async () => {
    for (let i = 0; i < 5; i++) {
      await audit.recordNow({ actor: { kind: "user", id: "q1", name: "q" }, action: i % 2 ? "relay.set" : "relay.pulse", outcome: i === 4 ? "denied" : "ok", equipment: { id: "eq", name: "EQ" } })
    }
    const p1 = await audit.query({ actorId: "q1", limit: 2 })
    expect(p1.items).toHaveLength(2)
    expect(p1.items[0].id).toBeGreaterThan(p1.items[1].id)
    expect(p1.nextCursor).not.toBeNull()
    const p2 = await audit.query({ actorId: "q1", limit: 2, cursor: Number(p1.nextCursor) })
    expect(p2.items[0].id).toBeLessThan(p1.items[1].id)
    const p3 = await audit.query({ actorId: "q1", limit: 2, cursor: Number(p2.nextCursor) })
    expect(p3.items).toHaveLength(1)
    expect(p3.nextCursor).toBeNull()
    expect((await audit.query({ category: "relay", limit: 50 })).items).toHaveLength(5)
    expect((await audit.query({ action: "relay.set", limit: 50 })).items).toHaveLength(2)
    expect((await audit.query({ outcome: "denied", limit: 50 })).items).toHaveLength(1)
    expect((await audit.query({ equipmentId: "eq", limit: 50 })).items).toHaveLength(5)
    const future = new Date(Date.now() + 60_000).toISOString()
    expect((await audit.query({ from: future, limit: 50 })).items).toHaveLength(0)
    expect((await audit.query({ to: future, actorId: "q1", limit: 50 })).items).toHaveLength(5)
    const item = p1.items[0]
    expect(item.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })

  it("purgeOlderThan deletes only old rows, re-locks and records audit.purge", async () => {
    const old = new Date(Date.now() - 400 * 86_400_000)
    await db.prisma.auditEvent.create({ data: { actorName: "sistema", action: "system.start", at: old } })
    await db.prisma.auditEvent.create({ data: { actorName: "sistema", action: "system.start", at: old } })
    const before = await db.prisma.auditEvent.count()
    const n = await audit.purgeOlderThan(365)
    expect(n).toBe(2)
    await audit.flush()
    expect(await db.prisma.auditEvent.count()).toBe(before - 2 + 1)
    const s = await db.prisma.settings.findUniqueOrThrow({ where: { id: "global" } })
    expect(s.auditPurgeUnlocked).toBe(false)
    const purge = await db.prisma.auditEvent.findFirstOrThrow({ where: { action: "audit.purge" } })
    expect(purge.detail).toMatchObject({ deleted: 2 })
    await expect(db.prisma.auditEvent.deleteMany({})).rejects.toThrow()
  })
})
