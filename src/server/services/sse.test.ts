import pkg from "../../../package.json"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { ServerEvent } from "@/lib/contracts/events"
import { createNullLogger } from "@/server/log"
import type { AuthenticatedSession, AuthUser, LiveSession } from "@/server/runtime/types"
import { createTestDb, fakeAudit, fakeBus, fakeSessions, fakeSettings, makeUser, testConfig } from "../../../test/helpers"
import { createReservationService } from "./reservations"
import {
  openEventStream, SSE_MAX_QUEUED_CHUNKS, SSE_MAX_STREAMS_PER_USER, type EventStreamDeps, type EventStreamOptions,
} from "./sse"

const viewer = (over: Partial<AuthUser> = {}): AuthUser => ({
  id: "u1", username: "ana", name: "Ana", isAdmin: false, roleIds: [], mustChangePassword: false, sessionVersion: 1, ...over,
})
const sessionOf = (u: AuthUser): AuthenticatedSession => ({ user: u, sv: u.sessionVersion, loginAt: Date.now() })

let bus: ReturnType<typeof fakeBus>
let sessions: ReturnType<typeof fakeSessions>
let deps: EventStreamDeps
let controllers: AbortController[]

beforeEach(() => {
  bus = fakeBus()
  sessions = fakeSessions()
  deps = { bus, sessions, prisma: undefined as unknown as EventStreamDeps["prisma"], config: testConfig(), log: createNullLogger() }
  controllers = []
})
afterEach(() => { for (const c of controllers) c.abort() })

function open(u: AuthUser, opts: Partial<EventStreamOptions> = {}) {
  const ac = new AbortController()
  controllers.push(ac)
  const r = openEventStream(deps, {
    session: sessionOf(u), signal: ac.signal, heartbeatMs: 60_000, debounceMs: 5,
    visibility: async () => new Set(["eqA"]),
    ...opts,
  })
  return { r, ac }
}

/** Reads SSE frames and returns the parsed `data:` events (plus raw text for comments). */
function frameReader(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader()
  const dec = new TextDecoder()
  let buf = ""
  let raw = ""
  const queue: ServerEvent[] = []
  let done = false
  async function pump(): Promise<void> {
    const { value, done: d } = await reader.read()
    if (d) { done = true; return }
    const text = dec.decode(value, { stream: true })
    raw += text
    buf += text
    let i: number
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, i)
      buf = buf.slice(i + 2)
      const data = frame.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n")
      if (data) queue.push(JSON.parse(data) as ServerEvent)
    }
  }
  return {
    get raw() { return raw },
    async next(): Promise<ServerEvent> {
      while (!queue.length) {
        if (done) throw new Error("stream closed")
        await pump()
      }
      return queue.shift() as ServerEvent
    },
    /** Resolves true when the stream ends before another event arrives. */
    async ended(): Promise<boolean> {
      while (!done) {
        if (queue.length) return false
        await pump()
      }
      return !queue.length
    },
    cancel: () => reader.cancel(),
  }
}

const sentinel = (n: number): ServerEvent => ({ type: "equipment.changed", equipmentId: `s${n}`, change: "updated" })

describe("SSE stream (§4.13)", () => {
  it("sends retry and hello first, and delivers an event published during the visibility query (subscribe before hello)", async () => {
    const { r } = open(viewer(), {
      visibility: async () => {
        bus.publish({ type: "toast", level: "info", message: "durante" }, { kind: "user", userId: "u1" })
        return new Set(["eqA"])
      },
    })
    if (!r.ok) throw new Error("expected a stream")
    const f = frameReader(r.stream)
    const hello = await f.next()
    expect(hello).toMatchObject({ type: "hello", viewerId: "u1", version: pkg.version, buildId: "dev" })
    expect(hello.type === "hello" && Date.parse(hello.serverNow)).toBeGreaterThan(0)
    expect(f.raw.startsWith("retry: 3000\n\n")).toBe(true)
    expect(await f.next()).toEqual({ type: "toast", level: "info", message: "durante" })
    expect(f.raw).toMatch(/id: \d+\ndata: \{"type":"hello"/)
    expect(sessions.count({ userId: "u1", kind: "sse" })).toBe(1)
  })

  it("filters by audience per the §4.13 table", async () => {
    const { r } = open(viewer())
    if (!r.ok) throw new Error("expected a stream")
    const f = frameReader(r.stream)
    await f.next()
    const rc = (id: string): ServerEvent => ({ type: "reservation.changed", equipmentId: id, equipmentName: id, reservation: null, cause: "release", byName: null, serverNow: new Date().toISOString() })
    bus.publish(rc("eqB"), { kind: "equipment", equipmentId: "eqB" })              // not visible
    bus.publish({ type: "viewer.changed", userId: "u2" }, { kind: "user", userId: "u2" })  // other user
    bus.publish({ type: "discovery.progress", runId: "r", done: 1, total: 2 }, { kind: "admins" })
    bus.publish(rc("eqA"), { kind: "equipment", equipmentId: "eqA" })              // visible
    bus.publish({ type: "toast", level: "info", message: "hola" }, { kind: "user", userId: "u1" })
    bus.publish({ type: "settings.changed", labName: "X", bannerText: null, reservationWarningMin: 5 }, { kind: "all" })
    expect((await f.next()).type).toBe("reservation.changed")
    expect(await f.next()).toMatchObject({ type: "toast", message: "hola" })
    expect(await f.next()).toMatchObject({ type: "settings.changed" })
  })

  it("admins receive 'admins' events and 'all' equipment; a demoted admin stops after refresh", async () => {
    const admin = viewer({ isAdmin: true })
    const { r } = open(admin, { visibility: async (u) => (u.isAdmin ? "all" : new Set<string>()) })
    if (!r.ok) throw new Error("expected a stream")
    const f = frameReader(r.stream)
    await f.next()
    bus.publish({ type: "discovery.progress", runId: "r", done: 1, total: 2 }, { kind: "admins" })
    bus.publish({ type: "console.activity", equipmentId: "any", consoleId: "c", lastLine: "x", lastRxAt: new Date().toISOString() }, { kind: "equipment", equipmentId: "any" })
    expect((await f.next()).type).toBe("discovery.progress")
    expect((await f.next()).type).toBe("console.activity")
    const live = [...sessions.sessions][0] as LiveSession
    live.refresh({ ...admin, isAdmin: false })
    bus.publish({ type: "discovery.progress", runId: "r", done: 2, total: 2 }, { kind: "admins" })
    bus.publish({ type: "console.activity", equipmentId: "any", consoleId: "c", lastLine: "y", lastRxAt: new Date().toISOString() }, { kind: "equipment", equipmentId: "any" })
    bus.publish(sentinel(1), { kind: "all" })
    expect(await f.next()).toEqual(sentinel(1))
  })

  it("recomputes the visible set after equipment.changed (debounced)", async () => {
    let visible = new Set(["eqA"])
    const { r } = open(viewer(), { visibility: async () => visible })
    if (!r.ok) throw new Error("expected a stream")
    const f = frameReader(r.stream)
    await f.next()
    visible = new Set(["eqA", "eqNew"])
    bus.publish({ type: "equipment.changed", equipmentId: "eqNew", change: "created" }, { kind: "all" })
    expect((await f.next()).type).toBe("equipment.changed")
    await new Promise((res) => setTimeout(res, 30))
    bus.publish({ type: "relay.state", equipmentId: "eqNew", channels: [], at: new Date().toISOString() }, { kind: "equipment", equipmentId: "eqNew" })
    expect(await f.next()).toMatchObject({ type: "relay.state", equipmentId: "eqNew" })
  })

  it("abort cleans up the bus listener and unregisters the live session", async () => {
    const before = bus.listenerCount()
    const { r, ac } = open(viewer())
    if (!r.ok) throw new Error("expected a stream")
    const f = frameReader(r.stream)
    await f.next()
    expect(bus.listenerCount()).toBe(before + 1)
    ac.abort()
    expect(await f.ended()).toBe(true)
    expect(bus.listenerCount()).toBe(before)
    expect(sessions.sessions.size).toBe(0)
  })

  it("cancel() by the consumer also cleans up", async () => {
    const { r } = open(viewer())
    if (!r.ok) throw new Error("expected a stream")
    const f = frameReader(r.stream)
    await f.next()
    await f.cancel()
    expect(bus.listenerCount()).toBe(0)
    expect(sessions.sessions.size).toBe(0)
  })

  it("LiveSession.revoke sends session.revoked and closes; a bus session.revoked for the viewer also closes", async () => {
    const a = open(viewer())
    if (!a.r.ok) throw new Error("expected a stream")
    const fa = frameReader(a.r.stream)
    await fa.next()
    ;([...sessions.sessions][0] as LiveSession).revoke("revoked")
    expect(await fa.next()).toEqual({ type: "session.revoked", userId: "u1", reason: "revoked" })
    expect(await fa.ended()).toBe(true)
    expect(bus.listenerCount()).toBe(0)

    const b = open(viewer())
    if (!b.r.ok) throw new Error("expected a stream")
    const fb = frameReader(b.r.stream)
    await fb.next()
    bus.publish({ type: "session.revoked", userId: "u1", reason: "disabled" }, { kind: "user", userId: "u1" })
    expect(await fb.next()).toEqual({ type: "session.revoked", userId: "u1", reason: "disabled" })
    expect(await fb.ended()).toBe(true)
  })

  it(`the ${SSE_MAX_STREAMS_PER_USER + 1}th stream of a user gets 429`, async () => {
    const opened = Array.from({ length: SSE_MAX_STREAMS_PER_USER }, () => open(viewer()))
    expect(opened.every((o) => o.r.ok)).toBe(true)
    const ninth = open(viewer())
    expect(ninth.r).toEqual({ ok: false, status: 429 })
    expect(bus.listenerCount()).toBe(SSE_MAX_STREAMS_PER_USER)
    expect(open(viewer({ id: "u2" })).r.ok).toBe(true)
    opened[0].ac.abort()
    expect(open(viewer()).r.ok).toBe(true)
  })

  it("sends a heartbeat event with serverNow and a ping comment", async () => {
    const { r } = open(viewer(), { heartbeatMs: 20 })
    if (!r.ok) throw new Error("expected a stream")
    const f = frameReader(r.stream)
    await f.next()
    const hb = await f.next()
    expect(hb.type).toBe("heartbeat")
    expect(f.raw).toContain(": ping\n\n")
  })
})

describe("SSE + reservations (acceptance: a console-input touch updates other viewers' countdown)", () => {
  it("another viewer's stream receives reservation.changed (cause renew) with the new expiresAt after touch()", async () => {
    const db = await createTestDb()
    try {
      let clock = new Date("2026-09-23T10:00:00.000Z")
      const svc = createReservationService({ config: testConfig(), log: createNullLogger(), prisma: db.prisma, bus, audit: fakeAudit(), settings: fakeSettings(), now: () => clock })
      await svc.start()
      const holder = await makeUser(db.prisma, { name: "Ana" })
      const other = await makeUser(db.prisma, { name: "Berta" })
      const eq = await db.prisma.equipment.create({ data: { name: "Equipo A #01" } })
      deps = { ...deps, prisma: db.prisma }
      const { r } = open(viewer({ id: other.id, username: other.username, name: "Berta" }), { visibility: undefined })
      if (!r.ok) throw new Error("expected a stream")
      const f = frameReader(r.stream)
      await f.next()
      await svc.reserve(eq.id, { id: holder.id, username: holder.username, name: "Ana", isAdmin: false, roleIds: [], mustChangePassword: false, sessionVersion: 1 })
      const reserved = await f.next()
      expect(reserved).toMatchObject({ type: "reservation.changed", cause: "reserve", reservation: { expiresAt: "2026-09-23T10:30:00.000Z" } })
      clock = new Date("2026-09-23T10:07:00.000Z")
      svc.touch(eq.id, holder.id, "console")
      await svc.idle()
      expect(await f.next()).toMatchObject({
        type: "reservation.changed", equipmentId: eq.id, cause: "renew", byName: "Ana",
        reservation: { holderId: holder.id, expiresAt: "2026-09-23T10:37:00.000Z" }, serverNow: "2026-09-23T10:07:00.000Z",
      })
      svc.stop()
    } finally {
      await db.cleanup()
    }
  })
})

describe("SSE backpressure", () => {
  it("drops a stream whose client stopped reading instead of queueing forever", async () => {
    const { r } = open(viewer())
    if (!r.ok) throw new Error("expected a stream")
    const reader = r.stream.getReader()
    await reader.read() // retry + hello start flowing; then the client stops reading
    await new Promise((res) => setTimeout(res, 10))
    for (let i = 0; i < SSE_MAX_QUEUED_CHUNKS + 10; i++) bus.publish(sentinel(i), { kind: "all" })
    expect(bus.listenerCount()).toBe(0)
    expect(sessions.sessions.size).toBe(0)
  })
})
