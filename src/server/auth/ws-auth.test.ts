import type { IncomingMessage } from "node:http"
import { encode } from "next-auth/jwt"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { authenticateCookieHeader, authenticateUpgrade, sessionCookieName } from "./ws-auth"
import { absoluteCapMs, refreshJwt, sessionFromToken } from "./callbacks"
import { setRuntime } from "@/server/runtime/registry"
import { createTestDb, fakeRuntime, makeUser, testConfig, type TestDb } from "../../../test/helpers"

const SECRET = "ws-auth-test-secret-0123456789abcdefghijklmnop"
let db: TestDb
let ana: { id: string }
let baja: { id: string }
let r1: { id: string }

beforeAll(async () => {
  db = await createTestDb()
  r1 = await db.prisma.role.create({ data: { name: "R1" } })
  ana = await makeUser(db.prisma, { username: "ana", roleIds: [r1.id] })
  baja = await makeUser(db.prisma, { username: "baja", disabled: true })
  setRuntime(fakeRuntime({ prisma: db.prisma, config: testConfig({ authSecret: SECRET }) }))
})
afterAll(async () => { await db.cleanup() })

async function token(claims: Record<string, unknown>, opts: { secret?: string; salt?: string } = {}) {
  return encode({ token: claims, secret: opts.secret ?? SECRET, salt: opts.salt ?? "authjs.session-token", maxAge: 3600 })
}
const req = (headers: Record<string, string>) => ({ headers }) as unknown as IncomingMessage

describe("authenticateCookieHeader", () => {
  it("decodes a plain session cookie and re-reads the user", async () => {
    const t = await token({ id: ana.id, sv: 1, loginAt: Date.now() })
    const s = await authenticateCookieHeader(`foo=bar; authjs.session-token=${t}`)
    expect(s).toMatchObject({ sv: 1, user: { id: ana.id, username: "ana", isAdmin: false, roleIds: [r1.id], sessionVersion: 1 } })
  })
  it("decodes a chunked cookie (.0, .1)", async () => {
    const t = await token({ id: ana.id, sv: 1, loginAt: Date.now() })
    const half = Math.floor(t.length / 2)
    const s = await authenticateCookieHeader(`authjs.session-token.0=${t.slice(0, half)}; authjs.session-token.1=${t.slice(half)}`)
    expect(s?.user.id).toBe(ana.id)
  })
  it("wrong secret → null", async () => {
    const t = await token({ id: ana.id, sv: 1, loginAt: Date.now() }, { secret: "another-secret-another-secret-another-secret" })
    expect(await authenticateCookieHeader(`authjs.session-token=${t}`)).toBeNull()
  })
  it("garbage and empty cookies → null", async () => {
    expect(await authenticateCookieHeader("")).toBeNull()
    expect(await authenticateCookieHeader("authjs.session-token=%E0%A4%A")).toBeNull()
  })
  it("uses the __Secure- cookie name (and salt) with TLS", async () => {
    setRuntime(fakeRuntime({ prisma: db.prisma, config: testConfig({ authSecret: SECRET, tls: { certFile: "/c", keyFile: "/k" } }) }))
    try {
      expect(sessionCookieName(true)).toBe("__Secure-authjs.session-token")
      const t = await token({ id: ana.id, sv: 1, loginAt: Date.now() }, { salt: "__Secure-authjs.session-token" })
      expect((await authenticateCookieHeader(`__Secure-authjs.session-token=${t}`))?.user.id).toBe(ana.id)
      expect(await authenticateCookieHeader(`authjs.session-token=${t}`)).toBeNull()
    } finally {
      setRuntime(fakeRuntime({ prisma: db.prisma, config: testConfig({ authSecret: SECRET }) }))
    }
  })
})

describe("authenticateUpgrade", () => {
  it("disabled user, sv mismatch and over the 72 h cap → null", async () => {
    const disabled = await token({ id: baja.id, sv: 1, loginAt: Date.now() })
    expect(await authenticateUpgrade(req({ cookie: `authjs.session-token=${disabled}` }))).toBeNull()
    const oldSv = await token({ id: ana.id, sv: 0, loginAt: Date.now() })
    expect(await authenticateUpgrade(req({ cookie: `authjs.session-token=${oldSv}` }))).toBeNull()
    const old = await token({ id: ana.id, sv: 1, loginAt: Date.now() - 73 * 3600_000 })
    expect(await authenticateUpgrade(req({ cookie: `authjs.session-token=${old}` }))).toBeNull()
    const missing = await token({ id: "nobody", sv: 1, loginAt: Date.now() })
    expect(await authenticateUpgrade(req({ cookie: `authjs.session-token=${missing}` }))).toBeNull()
  })
  it("Authorization: Bearer % without a cookie → null, never a throw", async () => {
    await expect(authenticateUpgrade(req({ authorization: "Bearer %" }))).resolves.toBeNull()
    const valid = await token({ id: ana.id, sv: 1, loginAt: Date.now() })
    await expect(authenticateUpgrade(req({ authorization: `Bearer ${valid}` }))).resolves.toBeNull()
  })
  it("a valid cookie authenticates", async () => {
    const t = await token({ id: ana.id, sv: 1, loginAt: Date.now() })
    expect((await authenticateUpgrade(req({ cookie: `authjs.session-token=${t}` })))?.user.username).toBe("ana")
  })
})

describe("jwt / session callbacks (§6.2)", () => {
  const deps = () => ({ prisma: db.prisma, maxAgeSec: 12 * 3600 })
  it("absolute cap is max(72 h, maxAge)", () => {
    expect(absoluteCapMs(12 * 3600)).toBe(72 * 3600_000)
    expect(absoluteCapMs(100 * 3600)).toBe(100 * 3600_000)
  })
  it("at sign-in sets id, sv and loginAt, then copies fresh fields", async () => {
    const t = await refreshJwt({}, { id: ana.id, sv: 1 }, deps())
    expect(t).toMatchObject({ id: ana.id, sv: 1, username: "ana", isAdmin: false, roleIds: [r1.id], mustChangePassword: false })
    expect(typeof t?.loginAt).toBe("number")
  })
  it("returns null for missing/disabled users, sv mismatch and past the cap", async () => {
    expect(await refreshJwt({ id: "nobody", sv: 1, loginAt: Date.now() }, undefined, deps())).toBeNull()
    expect(await refreshJwt({ id: baja.id, sv: 1, loginAt: Date.now() }, undefined, deps())).toBeNull()
    expect(await refreshJwt({ id: ana.id, sv: 2, loginAt: Date.now() }, undefined, deps())).toBeNull()
    expect(await refreshJwt({ id: ana.id, sv: 1, loginAt: Date.now() - 73 * 3600_000 }, undefined, deps())).toBeNull()
    expect(await refreshJwt({}, undefined, deps())).toBeNull()
  })
  it("re-reads role/admin changes on every call without logging out", async () => {
    const u = await makeUser(db.prisma, { username: "promo" })
    const t1 = await refreshJwt({}, { id: u.id, sv: 1 }, deps())
    await db.prisma.user.update({ where: { id: u.id }, data: { isAdmin: true, roles: { connect: [{ id: r1.id }] } } })
    const t2 = await refreshJwt(t1 ?? {}, undefined, deps())
    expect(t2).toMatchObject({ isAdmin: true, roleIds: [r1.id] })
  })
  it("session exposes id, username, name, isAdmin, roleIds, mustChangePassword", () => {
    const s = sessionFromToken(
      { user: { name: "x", email: null, image: null }, expires: "2026-09-24T00:00:00.000Z" },
      { id: "u1", sv: 1, loginAt: 1, username: "ana", name: "Ana", isAdmin: true, roleIds: ["r"], mustChangePassword: true },
    )
    expect(s.user).toMatchObject({ id: "u1", username: "ana", name: "Ana", isAdmin: true, roleIds: ["r"], mustChangePassword: true })
  })
})
