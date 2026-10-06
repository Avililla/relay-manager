import http from "node:http"
import type { AddressInfo } from "node:net"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { authorizeCredentials, DisabledError, RateLimitedError } from "./authorize"
import { createLoginThrottle } from "./throttle"
import { createRequestListener } from "@/server/http/listen"
import { clientIp } from "@/server/request-meta"
import type { LoginThrottle } from "@/server/runtime/types"
import { createTestDb, fakeAudit, makeUser, testConfig, type TestDb } from "../../../test/helpers"

let db: TestDb
let audit: ReturnType<typeof fakeAudit>
let throttle: LoginThrottle
const deps = () => ({ prisma: db.prisma, throttle, audit })

beforeAll(async () => {
  db = await createTestDb()
  await makeUser(db.prisma, { username: "ana", password: "correcta-123" })
  await makeUser(db.prisma, { username: "baja", password: "correcta-123", disabled: true })
})
afterAll(async () => { await db.cleanup() })
beforeEach(() => { audit = fakeAudit(); throttle = createLoginThrottle() })

const fails = () => audit.inputs.filter((i) => i.action === "auth.login.fail")

describe("authorizeCredentials (ordered algorithm, §6.3)", () => {
  it("step 2: invalid input fails, is audited and counts toward the IP window", async () => {
    const r = await authorizeCredentials({ username: "NO VÁLIDO!!", password: "" }, "9.9.9.9", deps())
    expect(r).toBeNull()
    expect(fails()[0]).toMatchObject({ actor: { name: "(no válido)" }, detail: { reason: "invalid-input", username: "NO VÁLIDO!!" } })
    expect(fails()[0].actor.ip).toBe("9.9.9.9")
    const long = "x".repeat(200)
    await authorizeCredentials({ username: long }, "9.9.9.9", deps())
    expect((fails()[1].detail as { username: string }).username).toHaveLength(64)
    for (let i = 0; i < 18; i++) await authorizeCredentials({}, "9.9.9.9", deps())
    // 20 failures from this IP: the IP is now blocked, even for a valid login
    await expect(authorizeCredentials({ username: "ana", password: "correcta-123" }, "9.9.9.9", deps())).rejects.toBeInstanceOf(RateLimitedError)
  })

  it("step 5: wrong password → bad-credentials (audited)", async () => {
    expect(await authorizeCredentials({ username: "ana", password: "mala" }, "1.1.1.1", deps())).toBeNull()
    expect(fails()[0]).toMatchObject({ outcome: "ok", detail: { reason: "bad-credentials", username: "ana" } })
  })

  it("missing user → bad-credentials (dummy hash compare)", async () => {
    expect(await authorizeCredentials({ username: "nadie", password: "loquesea" }, "1.1.1.1", deps())).toBeNull()
    expect(fails()[0].detail).toMatchObject({ reason: "bad-credentials" })
  })

  it("a disabled user with a wrong password gets bad-credentials; with the right one, DisabledError", async () => {
    expect(await authorizeCredentials({ username: "baja", password: "mala" }, "1.1.1.1", deps())).toBeNull()
    expect(fails()[0].detail).toMatchObject({ reason: "bad-credentials" })
    await expect(authorizeCredentials({ username: "baja", password: "correcta-123" }, "1.1.1.1", deps())).rejects.toBeInstanceOf(DisabledError)
    expect(fails()[1].detail).toMatchObject({ reason: "disabled" })
  })

  it("step 6: success returns the user, updates lastLoginAt, audits ok and clears the pair window", async () => {
    for (let i = 0; i < 4; i++) await authorizeCredentials({ username: "ana", password: "mala" }, "2.2.2.2", deps())
    const u = await authorizeCredentials({ username: "ANA", password: "correcta-123" }, "2.2.2.2", deps())
    expect(u).toMatchObject({ username: "ana", sv: 1 })
    const row = await db.prisma.user.findUniqueOrThrow({ where: { username: "ana" } })
    expect(row.lastLoginAt).not.toBeNull()
    expect(audit.inputs.at(-1)).toMatchObject({ action: "auth.login.ok", actor: { kind: "user", id: row.id, name: "ana", ip: "2.2.2.2" } })
    // window cleared: 5 more failures are allowed before blocking
    for (let i = 0; i < 5; i++) expect(await authorizeCredentials({ username: "ana", password: "mala" }, "2.2.2.2", deps())).toBeNull()
    await expect(authorizeCredentials({ username: "ana", password: "mala" }, "2.2.2.2", deps())).rejects.toBeInstanceOf(RateLimitedError)
  })

  it("step 3: throttled attempts are audited at most once per block window", async () => {
    for (let i = 0; i < 5; i++) await authorizeCredentials({ username: "ana", password: "mala" }, "3.3.3.3", deps())
    for (let i = 0; i < 3; i++) {
      await expect(authorizeCredentials({ username: "ana", password: "mala" }, "3.3.3.3", deps())).rejects.toBeInstanceOf(RateLimitedError)
    }
    expect(fails().filter((f) => (f.detail as { reason: string }).reason === "throttled")).toHaveLength(1)
  })

  it("N parallel attempts from one IP give at most the window's allowance", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => authorizeCredentials({ username: "ana", password: "mala" }, "4.4.4.4", deps())),
    )
    const verified = results.filter((r) => r.status === "fulfilled")
    const limited = results.filter((r) => r.status === "rejected" && r.reason instanceof RateLimitedError)
    expect(verified).toHaveLength(5)
    expect(limited).toHaveLength(5)
  })
})

describe("login behind the request listener", () => {
  it("a changing X-Forwarded-For is still blocked after 5 failures; the audited ip is the socket address", async () => {
    const server = http.createServer()
    let port = 0
    server.on("request", (req, res) =>
      createRequestListener(testConfig({ port }), (r, s) => {
        let body = ""
        r.on("data", (c: Buffer) => { body += c.toString() })
        r.on("end", () => {
          authorizeCredentials(JSON.parse(body), clientIp(r.headers), deps())
            .then((u) => { s.end(JSON.stringify({ ok: !!u })) })
            .catch((e: unknown) => { s.end(JSON.stringify({ error: e instanceof RateLimitedError ? "rate_limited" : "other" })) })
        })
      })(req, res),
    )
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    port = (server.address() as AddressInfo).port
    try {
      const results: string[] = []
      for (let i = 0; i < 7; i++) {
        const res = await fetch(`http://127.0.0.1:${port}/api/auth/callback/credentials`, {
          method: "POST",
          headers: { origin: `http://127.0.0.1:${port}`, "x-forwarded-for": `10.0.0.${i}`, "x-real-ip": `10.1.0.${i}` },
          body: JSON.stringify({ username: "ana", password: "mala" }),
        })
        results.push(await res.text())
      }
      expect(results.slice(0, 5).every((r) => r === '{"ok":false}')).toBe(true)
      expect(results[5]).toBe('{"error":"rate_limited"}')
      expect(results[6]).toBe('{"error":"rate_limited"}')
      expect(new Set(fails().map((f) => f.actor.ip))).toEqual(new Set(["127.0.0.1"]))
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
