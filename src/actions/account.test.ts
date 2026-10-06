import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { changeOwnPassword, setMyTheme } from "./account"
import { verifyPassword } from "@/server/auth/passwords"
import { setRuntime } from "@/server/runtime/registry"
import type { AuthUser } from "@/server/runtime/types"
import { createTestDb, fakeAudit, fakeBus, fakeRuntime, makeUser, type TestDb } from "../../test/helpers"

const state = vi.hoisted(() => ({ user: null as AuthUser | null }))
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-forwarded-for": "10.0.0.9" }) }))
vi.mock("@/server/authz", () => ({ getAuthUser: async () => state.user }))

let db: TestDb
let audit: ReturnType<typeof fakeAudit>
let bus: ReturnType<typeof fakeBus>
let uid: string
beforeAll(async () => { db = await createTestDb() })
afterAll(async () => { await db.cleanup() })
beforeEach(async () => {
  const u = await makeUser(db.prisma, { password: "clave-actual-1", mustChangePassword: true })
  uid = u.id
  state.user = { id: u.id, username: u.username, name: u.name, isAdmin: false, roleIds: [], mustChangePassword: true, sessionVersion: 1 }
  audit = fakeAudit(); bus = fakeBus()
  setRuntime(fakeRuntime({ prisma: db.prisma, audit, bus }))
})

describe("changeOwnPassword", () => {
  it("verifies the current password, clears mustChangePassword, bumps sessionVersion, audits and publishes", async () => {
    const r = await changeOwnPassword({ currentPassword: "clave-actual-1", newPassword: "clave-nueva-22", confirmPassword: "clave-nueva-22" })
    expect(r).toEqual({ ok: true, data: null })
    const u = await db.prisma.user.findUniqueOrThrow({ where: { id: uid } })
    expect(u.mustChangePassword).toBe(false)
    expect(u.sessionVersion).toBe(2)
    expect(await verifyPassword("clave-nueva-22", u.passwordHash)).toBe(true)
    expect(audit.inputs.map((i) => i.action)).toEqual(["auth.password.changed"])
    expect(JSON.stringify(audit.inputs[0])).not.toContain("clave-nueva-22")
    expect(bus.events[0]).toEqual({ event: { type: "session.revoked", userId: uid, reason: "password-changed" }, audience: { kind: "user", userId: uid } })
  })
  it("a wrong current password → VALIDATION on currentPassword, nothing changes", async () => {
    const r = await changeOwnPassword({ currentPassword: "mala-clave-99", newPassword: "clave-nueva-22", confirmPassword: "clave-nueva-22" })
    expect(r).toMatchObject({ ok: false, error: { code: "VALIDATION", fieldErrors: { currentPassword: [expect.any(String)] } } })
    expect((await db.prisma.user.findUniqueOrThrow({ where: { id: uid } })).sessionVersion).toBe(1)
  })
})

describe("setMyTheme (the theme is saved in the account, D39)", () => {
  it("saves it, tells only this user's other tabs and PCs, and audits nothing (cosmetic preference)", async () => {
    const r = await setMyTheme({ theme: "rosa" })
    expect(r).toEqual({ ok: true, data: { theme: "rosa" } })
    expect((await db.prisma.user.findUniqueOrThrow({ where: { id: uid } })).theme).toBe("rosa")
    expect(bus.events).toEqual([{ event: { type: "account.prefs.changed", userId: uid, theme: "rosa" }, audience: { kind: "user", userId: uid } }])
    expect(audit.inputs).toEqual([])
  })
  it("accepts the four themes and is allowed while a password change is pending", async () => {
    expect(state.user?.mustChangePassword).toBe(true)
    for (const theme of ["dark", "light", "system", "rosa"] as const) {
      expect(await setMyTheme({ theme })).toEqual({ ok: true, data: { theme } })
      expect((await db.prisma.user.findUniqueOrThrow({ where: { id: uid } })).theme).toBe(theme)
    }
  })
  it("an unknown theme → VALIDATION, nothing saved or published", async () => {
    for (const bad of [{ theme: "sepia" }, { theme: null }, {}, { theme: "Rosa" }]) {
      const r = await setMyTheme(bad as never)
      expect(r).toMatchObject({ ok: false, error: { code: "VALIDATION" } })
    }
    expect((await db.prisma.user.findUniqueOrThrow({ where: { id: uid } })).theme).toBeNull()
    expect(bus.events).toEqual([])
  })
  it("without a session → UNAUTHENTICATED, and only the caller's own account can change", async () => {
    const other = await makeUser(db.prisma)
    state.user = null
    expect(await setMyTheme({ theme: "light" })).toMatchObject({ ok: false, error: { code: "UNAUTHENTICATED" } })
    expect((await db.prisma.user.findUniqueOrThrow({ where: { id: other.id } })).theme).toBeNull()
    // There is no user id in the input: extra keys are ignored and the session's user is the one saved.
    state.user = { id: uid, username: "x", name: "x", isAdmin: false, roleIds: [], mustChangePassword: false, sessionVersion: 1 }
    expect(await setMyTheme({ theme: "light", userId: other.id } as never)).toMatchObject({ ok: true })
    expect((await db.prisma.user.findUniqueOrThrow({ where: { id: other.id } })).theme).toBeNull()
    expect((await db.prisma.user.findUniqueOrThrow({ where: { id: uid } })).theme).toBe("light")
  })
})
