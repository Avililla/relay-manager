import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { createSessionRegistry } from "./sessions"
import { createEventBus } from "@/server/events/bus"
import { createNullLogger } from "@/server/log"
import type { PrismaClient } from "@/generated/prisma/client"
import type { AuthUser, LiveSession } from "@/server/runtime/types"
import { createTestDb, makeUser, testConfig, type TestDb } from "../../../test/helpers"

let db: TestDb
beforeAll(async () => { db = await createTestDb() })
afterAll(async () => { await db.cleanup() })
afterEach(() => { vi.useRealTimers() })

function countingPrisma(): { prisma: PrismaClient; count: () => number } {
  let n = 0
  const prisma = { user: { findMany: (args: Parameters<PrismaClient["user"]["findMany"]>[0]) => { n++; return db.prisma.user.findMany(args) } } }
  return { prisma: prisma as unknown as PrismaClient, count: () => n }
}

function session(userId: string, over: Partial<LiveSession> = {}) {
  const calls: { revoke: string[]; refresh: AuthUser[] } = { revoke: [], refresh: [] }
  const s: LiveSession = {
    userId, sv: 1, loginAt: Date.now(), kind: "sse",
    revoke: (reason) => { calls.revoke.push(reason) },
    refresh: (user) => { calls.refresh.push(user) },
    ...over,
  }
  return { s, calls }
}

describe("session registry", () => {
  it("revokes disabled, deleted and sv-changed users, expires past the cap, refreshes the rest, with one query", async () => {
    const ok = await makeUser(db.prisma)
    const dis = await makeUser(db.prisma)
    const del = await makeUser(db.prisma)
    const bumped = await makeUser(db.prisma)
    const old = await makeUser(db.prisma)
    const { prisma, count } = countingPrisma()
    const reg = createSessionRegistry({ prisma, bus: createEventBus(), log: createNullLogger(), config: testConfig() })
    const a = session(ok.id)
    const b = session(dis.id)
    const c = session(del.id)
    const d = session(bumped.id)
    const e = session(old.id, { loginAt: Date.now() - 73 * 3600_000 })
    for (const x of [a, b, c, d, e]) reg.register(x.s)
    expect(reg.count()).toBe(5)
    await db.prisma.user.update({ where: { id: dis.id }, data: { disabled: true } })
    await db.prisma.user.delete({ where: { id: del.id } })
    await db.prisma.user.update({ where: { id: bumped.id }, data: { sessionVersion: 2 } })
    await reg.sweep()
    expect(count()).toBe(1)
    expect(a.calls.revoke).toEqual([])
    expect(a.calls.refresh[0]).toMatchObject({ id: ok.id, username: ok.username, isAdmin: false, roleIds: [], sessionVersion: 1 })
    expect(b.calls.revoke).toEqual(["revoked"])
    expect(c.calls.revoke).toEqual(["revoked"])
    expect(d.calls.revoke).toEqual(["revoked"])
    expect(e.calls.revoke).toEqual(["expired"])
    // revoked sessions are dropped from the registry
    expect(reg.count()).toBe(1)
  })

  it("register returns unregister; count filters by user and kind", async () => {
    const u = await makeUser(db.prisma)
    const reg = createSessionRegistry({ prisma: db.prisma, bus: createEventBus(), log: createNullLogger(), config: testConfig() })
    const off1 = reg.register(session(u.id, { kind: "console" }).s)
    reg.register(session(u.id, { kind: "sse" }).s)
    reg.register(session("other", { kind: "sse" }).s)
    expect(reg.count({ userId: u.id })).toBe(2)
    expect(reg.count({ kind: "sse" })).toBe(2)
    expect(reg.count({ userId: u.id, kind: "console" })).toBe(1)
    off1()
    expect(reg.count({ userId: u.id })).toBe(1)
  })

  it("sweeps immediately on viewer.changed and session.revoked", async () => {
    const u = await makeUser(db.prisma)
    const bus = createEventBus()
    const reg = createSessionRegistry({ prisma: db.prisma, bus, log: createNullLogger(), config: testConfig() })
    reg.start()
    try {
      const x = session(u.id)
      reg.register(x.s)
      bus.publish({ type: "viewer.changed", userId: u.id }, { kind: "user", userId: u.id })
      await vi.waitFor(() => expect(x.calls.refresh.length).toBe(1))
      await db.prisma.user.update({ where: { id: u.id }, data: { sessionVersion: 5 } })
      bus.publish({ type: "session.revoked", userId: u.id, reason: "password-changed" }, { kind: "user", userId: u.id })
      await vi.waitFor(() => expect(x.calls.revoke).toEqual(["revoked"]))
    } finally {
      reg.stop()
    }
    expect(bus.listenerCount()).toBe(0)
  })

  it("the 30 s timer closes a disabled user's SSE session (DB change from outside, e.g. the CLI)", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
    const u = await makeUser(db.prisma)
    const reg = createSessionRegistry({ prisma: db.prisma, bus: createEventBus(), log: createNullLogger(), config: testConfig() })
    reg.start()
    try {
      const x = session(u.id, { kind: "sse" })
      reg.register(x.s)
      await db.prisma.user.update({ where: { id: u.id }, data: { disabled: true } })
      await vi.advanceTimersByTimeAsync(30_000)
      await vi.waitFor(() => expect(x.calls.revoke).toEqual(["revoked"]))
    } finally {
      reg.stop()
    }
  })

  it("a listener that throws does not break the sweep", async () => {
    const u = await makeUser(db.prisma)
    const reg = createSessionRegistry({ prisma: db.prisma, bus: createEventBus(), log: createNullLogger(), config: testConfig() })
    const bad = session(u.id, { refresh: () => { throw new Error("boom") } })
    const good = session(u.id)
    reg.register(bad.s)
    reg.register(good.s)
    await expect(reg.sweep()).resolves.toBeUndefined()
    expect(good.calls.refresh).toHaveLength(1)
  })
})
