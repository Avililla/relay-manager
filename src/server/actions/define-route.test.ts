import { NextRequest } from "next/server"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"
import { defineRoute } from "./define-route"
import { DomainError } from "@/server/errors"
import { setRuntime } from "@/server/runtime/registry"
import type { AuthUser } from "@/server/runtime/types"
import { fakeAudit, fakeRuntime } from "../../../test/helpers"

const state = vi.hoisted(() => ({ user: null as AuthUser | null }))
vi.mock("@/server/authz", () => ({ getAuthUser: async () => state.user }))

const user = (over: Partial<AuthUser> = {}): AuthUser => ({
  id: "u1", username: "ana", name: "Ana", isAdmin: false, roleIds: [], mustChangePassword: false, sessionVersion: 1, ...over,
})
let audit: ReturnType<typeof fakeAudit>
beforeEach(() => { audit = fakeAudit(); setRuntime(fakeRuntime({ audit })); state.user = user() })

const req = (url = "http://bench:3000/api/x?cursor=5") => new NextRequest(url, { headers: { "x-forwarded-for": "10.1.1.1" } })
const rc = (params: Record<string, string> = {}) => ({ params: Promise.resolve(params) })

describe("defineRoute", () => {
  it("parses Promise params and query, sets Cache-Control: no-store", async () => {
    const GET = defineRoute(
      { auth: "user", operation: "test.read", params: z.object({ id: z.string().regex(/^[a-z0-9]+$/) }), query: z.object({ cursor: z.coerce.number().int() }) },
      async ({ params, query, ip, actor }) => Response.json({ id: params.id, cursor: query.cursor, ip, actor: actor.name }),
    )
    const res = await GET(req(), rc({ id: "abc" }))
    expect(res.status).toBe(200)
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect(await res.json()).toEqual({ id: "abc", cursor: 5, ip: "10.1.1.1", actor: "ana" })
  })
  it("keeps a Cache-Control set by the handler", async () => {
    const GET = defineRoute({ auth: "user", operation: "x" }, async () => new Response("x", { headers: { "cache-control": "private, max-age=5" } }))
    expect((await GET(req(), rc())).headers.get("cache-control")).toBe("private, max-age=5")
  })
  it("status mapping: 401, 403 (+audit), 400, 404, 429, 500", async () => {
    state.user = null
    const ok = defineRoute({ auth: "user", operation: "x" }, async () => new Response("ok"))
    let res = await ok(req(), rc())
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: "UNAUTHENTICATED" })

    state.user = user()
    res = await defineRoute({ auth: "admin", operation: "audit.export" }, async () => new Response("ok"))(req(), rc())
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: "FORBIDDEN" })
    expect(audit.inputs[0]).toMatchObject({ action: "auth.denied", outcome: "denied", detail: { operation: "audit.export", code: "FORBIDDEN" }, actor: { ip: "10.1.1.1" } })

    state.user = user({ mustChangePassword: true })
    res = await ok(req(), rc())
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: "PASSWORD_CHANGE_REQUIRED" })
    res = await defineRoute({ auth: "user", operation: "x", allowMustChangePassword: true }, async () => new Response("ok"))(req(), rc())
    expect(res.status).toBe(200)

    state.user = user()
    res = await defineRoute({ auth: "user", operation: "x", params: z.object({ id: z.string().min(5) }) }, async () => new Response("ok"))(req(), rc({ id: "a" }))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: "VALIDATION" })

    const throwing = (code: "NOT_FOUND" | "RATE_LIMITED" | "CONFLICT") =>
      defineRoute({ auth: "user", operation: "x" }, async () => { throw new DomainError(code, "x") })
    expect((await throwing("NOT_FOUND")(req(), rc())).status).toBe(404)
    expect((await throwing("RATE_LIMITED")(req(), rc())).status).toBe(429)
    const internal = await throwing("CONFLICT")(req(), rc())
    expect(internal.status).toBe(500)
    const body = await internal.json() as { error: string; ref: string }
    expect(body.error).toBe("INTERNAL")
    expect(body.ref).toMatch(/^[0-9a-f]{8}$/)
    const crash = await defineRoute({ auth: "user", operation: "x" }, async () => { throw new Error("boom") })(req(), rc())
    expect(crash.status).toBe(500)
    expect(crash.headers.get("cache-control")).toBe("no-store")
  })
})
