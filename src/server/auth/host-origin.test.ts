// Server-side Auth.js redirects keep the host the browser used (§6.4): NextRequest rewrites 127.x.x.x and [::1] to
// `localhost`, so without the host-origin wrapper a credentials POST on http://127.0.0.1:PORT redirected to
// http://localhost:PORT (and treated a same-host callbackUrl as foreign).
import { NextRequest } from "next/server"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { setRuntime } from "@/server/runtime/registry"
import { createTestDb, fakeRuntime, makeUser, testConfig, type TestDb } from "../../../test/helpers"
import { withHostOrigin } from "./host-origin"

const SECRET = "host-origin-test-secret-0123456789abcdefghijkl"
const PASSWORD = "host-origin-pass-001"
type Handler = (req: NextRequest) => Promise<Response>
let db: TestDb
let POST: Handler
let GET: Handler

beforeAll(async () => {
  db = await createTestDb()
  await makeUser(db.prisma, { username: "ana", password: PASSWORD })
  setRuntime(fakeRuntime({ prisma: db.prisma, config: testConfig({ authSecret: SECRET }) }))
  process.env.AUTH_SECRET = SECRET // read when the Auth.js config is built (route import)
  const route = await import("@/app/api/auth/[...nextauth]/route")
  POST = route.POST
  GET = route.GET
})
afterAll(async () => {
  delete process.env.AUTH_SECRET
  await db.cleanup()
})

/** A route-handler request as Next builds it: the URL is on Next's own hostname, the Host is the browser's. */
function routeReq(host: string, path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): NextRequest {
  return new NextRequest(`http://localhost:3871${path}`, { method: init.method ?? "GET", headers: { host, ...init.headers }, body: init.body })
}

async function login(host: string, callbackUrl: string): Promise<Response> {
  const csrfRes = await GET(routeReq(host, "/api/auth/csrf"))
  const { csrfToken } = (await csrfRes.json()) as { csrfToken: string }
  const cookie = csrfRes.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ")
  const body = new URLSearchParams({ csrfToken, username: "ana", password: PASSWORD, callbackUrl }).toString()
  return POST(routeReq(host, "/api/auth/callback/credentials", {
    method: "POST", body,
    headers: { cookie, origin: `http://${host}`, "content-type": "application/x-www-form-urlencoded" },
  }))
}

describe("withHostOrigin", () => {
  it("keeps 127.0.0.1 in request.url (NextRequest alone rewrites it to localhost)", () => {
    const req = routeReq("127.0.0.1:3871", "/api/auth/session?x=1")
    expect(req.url).toBe("http://localhost:3871/api/auth/session?x=1")
    expect(withHostOrigin(req).url).toBe("http://127.0.0.1:3871/api/auth/session?x=1")
  })
  it("keeps [::1] and returns the same request when the Host already matches", () => {
    expect(withHostOrigin(routeReq("[::1]:3871", "/a")).url).toBe("http://[::1]:3871/a")
    const same = routeReq("localhost:3871", "/a")
    expect(withHostOrigin(same)).toBe(same)
  })
})

describe("credentials POST redirects (Auth.js baseUrl from Host)", () => {
  it("Host 127.0.0.1:<port> → Location on 127.0.0.1 (relative and same-host absolute callbackUrl)", async () => {
    const rel = await login("127.0.0.1:3871", "/")
    expect(rel.status).toBe(302)
    expect(rel.headers.get("location")).toBe("http://127.0.0.1:3871/")
    const abs = await login("127.0.0.1:3871", "http://127.0.0.1:3871/equipos")
    expect(abs.headers.get("location")).toBe("http://127.0.0.1:3871/equipos")
  })
  it("a foreign callbackUrl falls back to the same host", async () => {
    const res = await login("127.0.0.1:3871", "http://evil.example/x")
    expect(res.headers.get("location")).toBe("http://127.0.0.1:3871")
  })
  it("Host of a LAN IP keeps that IP", async () => {
    const res = await login("192.168.1.50:3871", "/equipos")
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe("http://192.168.1.50:3871/equipos")
  })
})
