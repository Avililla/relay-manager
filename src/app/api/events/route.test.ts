import { NextRequest } from "next/server"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { setRuntime } from "@/server/runtime/registry"
import type { AuthenticatedSession, AuthUser, LiveSession } from "@/server/runtime/types"
import { fakeBus, fakeRuntime, fakeSessions } from "../../../../test/helpers"
import { GET } from "./route"

const state = vi.hoisted(() => ({ user: null as AuthUser | null, session: null as AuthenticatedSession | null }))
vi.mock("@/server/authz", () => ({ getAuthUser: async () => state.user }))
vi.mock("@/server/auth/ws-auth", () => ({ authenticateCookieHeader: async () => state.session }))

const user: AuthUser = { id: "u1", username: "ana", name: "Ana", isAdmin: true, roleIds: [], mustChangePassword: true, sessionVersion: 3 }
let sessions: ReturnType<typeof fakeSessions>
let bus: ReturnType<typeof fakeBus>

beforeEach(() => {
  state.user = user
  state.session = { user, sv: 3, loginAt: Date.now() }
  sessions = fakeSessions()
  bus = fakeBus()
  setRuntime(fakeRuntime({ sessions, bus }))
})

function get(ac = new AbortController()) {
  return GET(new NextRequest("http://bench:3000/api/events", { headers: { cookie: "authjs.session-token=x" }, signal: ac.signal }), { params: Promise.resolve({}) })
}

describe("GET /api/events (§4.13)", () => {
  it("opens an SSE stream (also with mustChangePassword) and registers a live session", async () => {
    const ac = new AbortController()
    const res = await get(ac)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("text/event-stream; charset=utf-8")
    expect(res.headers.get("cache-control")).toBe("no-cache, no-transform")
    expect(res.headers.get("x-accel-buffering")).toBe("no")
    const reader = res.body?.getReader()
    if (!reader) throw new Error("no body")
    let text = ""
    while (!text.includes('"type":"hello"')) text += new TextDecoder().decode((await reader.read()).value)
    expect(text).toContain('"viewerId":"u1"')
    const [live] = [...sessions.sessions] as LiveSession[]
    expect(live).toMatchObject({ userId: "u1", sv: 3, kind: "sse" })
    ac.abort()
    await reader.cancel().catch(() => {})
    expect(sessions.sessions.size).toBe(0)
  })

  it("401 without a valid session cookie, 429 past 8 streams", async () => {
    state.session = null
    const r401 = await get()
    expect(r401.status).toBe(401)
    expect(await r401.json()).toEqual({ error: "UNAUTHENTICATED" })
    state.session = { user, sv: 3, loginAt: Date.now() }
    for (let i = 0; i < 8; i++) sessions.register({ userId: "u1", sv: 3, loginAt: 0, kind: "sse", revoke() {}, refresh() {} })
    const r429 = await get()
    expect(r429.status).toBe(429)
    expect(await r429.json()).toEqual({ error: "RATE_LIMITED" })
  })
})
