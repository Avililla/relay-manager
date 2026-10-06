import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import { completeSetup } from "./setup"
import { ensureSetupTokenFile, readSetupToken } from "@/server/auth/setup-token"
import { createLoginThrottle } from "@/server/auth/throttle"
import { verifyPassword } from "@/server/auth/passwords"
import { setRuntime } from "@/server/runtime/registry"
import type { Runtime } from "@/server/runtime/types"
import { createTestDb, fakeAudit, fakeRuntime, testConfig, type TestDb } from "../../test/helpers"

const ip = vi.hoisted(() => ({ value: "10.0.0.1" }))
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-forwarded-for": ip.value }) }))
vi.mock("next/cache", () => ({ revalidatePath: () => {} }))

let db: TestDb
let rt: Runtime
let audit: ReturnType<typeof fakeAudit>
let token: string
const dbs: TestDb[] = []
afterAll(async () => { for (const d of dbs) await d.cleanup() })

beforeEach(async () => {
  db = await createTestDb(); dbs.push(db)
  await db.prisma.settings.upsert({ where: { id: "global" }, create: {}, update: {} })
  token = ensureSetupTokenFile(db.dir, null)
  audit = fakeAudit()
  rt = fakeRuntime({ prisma: db.prisma, audit, throttle: createLoginThrottle(), config: testConfig({ dataDir: db.dir }) })
  rt.state.setupPending = true
  setRuntime(rt)
  ip.value = "10.0.0.1"
})

const input = (over: Record<string, string> = {}) => ({
  token: token.toLowerCase().replaceAll("-", " "), username: "Admin", name: "Administración", password: "una-clave-larga", passwordConfirm: "una-clave-larga", ...over,
})

describe("completeSetup", () => {
  it("creates the admin, ends setup, deletes the token and audits", async () => {
    const r = await completeSetup(input())
    expect(r).toEqual({ ok: true, data: { username: "admin" } })
    const u = await db.prisma.user.findUniqueOrThrow({ where: { username: "admin" } })
    expect(u).toMatchObject({ isAdmin: true, mustChangePassword: false, name: "Administración", disabled: false })
    expect(await verifyPassword("una-clave-larga", u.passwordHash)).toBe(true)
    expect((await db.prisma.settings.findUniqueOrThrow({ where: { id: "global" } })).setupCompletedAt).not.toBeNull()
    expect(readSetupToken(db.dir)).toBeNull()
    expect(rt.state.setupPending).toBe(false)
    expect(audit.inputs.map((i) => i.action)).toEqual(["auth.setup.completed"])
    expect(audit.inputs[0].actor).toMatchObject({ kind: "user", id: u.id, ip: "10.0.0.1" })
  })

  it("two racing submissions → one success, one SETUP_DONE, one admin", async () => {
    const [a, b] = await Promise.all([completeSetup(input({ username: "uno" })), completeSetup(input({ username: "dos" }))])
    const results = [a, b]
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect(results.filter((r) => !r.ok && r.error.code === "SETUP_DONE")).toHaveLength(1)
    expect(await db.prisma.user.count()).toBe(1)
  })

  it("a wrong token → SETUP_TOKEN_INVALID, audited at most once per IP per minute", async () => {
    for (let i = 0; i < 3; i++) {
      expect(await completeSetup(input({ token: "AAAA-BBBB-CCCC-DDDD" }))).toMatchObject({ ok: false, error: { code: "SETUP_TOKEN_INVALID" } })
    }
    const fails = audit.inputs.filter((i) => i.action === "auth.setup.fail")
    expect(fails).toHaveLength(1)
    expect(fails[0]).toMatchObject({ outcome: "ok", detail: { reason: "bad-token" }, actor: { ip: "10.0.0.1" } })
    expect(await db.prisma.user.count()).toBe(0)
  })

  it("is throttled per IP (10 per 10 min)", async () => {
    for (let i = 0; i < 10; i++) await completeSetup(input({ token: "AAAA-BBBB-CCCC-DDDD" }))
    const r = await completeSetup(input())
    expect(r).toMatchObject({ ok: false, error: { code: "RATE_LIMITED" } })
    ip.value = "10.0.0.2"
    expect((await completeSetup(input())).ok).toBe(true)
  })

  it("after setup → SETUP_DONE", async () => {
    expect((await completeSetup(input())).ok).toBe(true)
    ensureSetupTokenFile(db.dir, token)
    expect(await completeSetup(input({ username: "otro" }))).toMatchObject({ ok: false, error: { code: "SETUP_DONE" } })
  })

  it("validates input (passwords must match)", async () => {
    const r = await completeSetup(input({ passwordConfirm: "otra-cosa-distinta" }))
    expect(r).toMatchObject({ ok: false, error: { code: "VALIDATION", fieldErrors: { passwordConfirm: [expect.any(String)] } } })
  })
})
