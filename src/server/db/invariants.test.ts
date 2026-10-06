import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { ensureDbInvariants } from "./invariants"
import { createTestDb, type TestDb } from "../../../test/helpers"

let db: TestDb
beforeAll(async () => {
  db = await createTestDb()
  await db.prisma.settings.upsert({ where: { id: "global" }, create: {}, update: {} })
  await db.prisma.auditEvent.create({ data: { actorName: "sistema", action: "system.start" } })
})
afterAll(async () => { await db.cleanup() })

describe("db invariants", () => {
  it("is idempotent", async () => {
    await ensureDbInvariants(db.prisma)
    await ensureDbInvariants(db.prisma)
  })
  it("UPDATE on AuditEvent aborts", async () => {
    // Prisma's SQLite adapter maps the trigger's SQLITE_CONSTRAINT_TRIGGER to a generic constraint error.
    await expect(db.prisma.auditEvent.updateMany({ data: { actorName: "x" } })).rejects.toThrow()
    expect(await db.prisma.auditEvent.count({ where: { actorName: "x" } })).toBe(0)
    await expect(db.prisma.$executeRawUnsafe(`UPDATE "AuditEvent" SET "actorName" = 'x'`)).rejects.toThrow(/append-only/)
  })
  it("DELETE aborts unless auditPurgeUnlocked = 1", async () => {
    await expect(db.prisma.auditEvent.deleteMany({})).rejects.toThrow()
    expect(await db.prisma.auditEvent.count()).toBe(1)
    await db.prisma.settings.update({ where: { id: "global" }, data: { auditPurgeUnlocked: true } })
    await expect(db.prisma.auditEvent.deleteMany({})).resolves.toMatchObject({ count: 1 })
    await db.prisma.settings.update({ where: { id: "global" }, data: { auditPurgeUnlocked: false } })
  })
  it("the client runs in WAL mode with foreign keys on", async () => {
    const jm = await db.prisma.$queryRawUnsafe<Array<{ journal_mode: string }>>("PRAGMA journal_mode")
    const fk = await db.prisma.$queryRawUnsafe<Array<{ foreign_keys: number | bigint }>>("PRAGMA foreign_keys")
    expect(jm[0].journal_mode).toBe("wal")
    expect(Number(fk[0].foreign_keys)).toBe(1)
  })
})
