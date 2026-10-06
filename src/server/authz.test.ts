import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { errorMessage } from "@/lib/i18n/errors"
import { setRuntime } from "@/server/runtime/registry"
import { createTestDb, fakeRuntime, makeUser, type TestDb } from "../../test/helpers"

// Only the Auth.js session is faked: the user row is read from a real (migrated) SQLite DB.
const state = vi.hoisted(() => ({ session: null as null | { user: { id: string } } }))
vi.mock("@/server/auth", () => ({ auth: async () => state.session }))

import { getAuthUser, requireAdmin, requireUser } from "./authz"

let db: TestDb
const signIn = (id: string) => { state.session = { user: { id } } }

beforeAll(async () => {
  db = await createTestDb()
  setRuntime(fakeRuntime({ prisma: db.prisma }))
})
afterAll(async () => { await db.cleanup() })
beforeEach(() => { state.session = null })

describe("getAuthUser / requireUser without a session", () => {
  it("no session → null, and requireUser/requireAdmin reject UNAUTHENTICATED", async () => {
    expect(await getAuthUser()).toBeNull()
    await expect(requireUser()).rejects.toMatchObject({ name: "DomainError", code: "UNAUTHENTICATED" })
    await expect(requireUser({ allowMustChangePassword: true })).rejects.toMatchObject({ code: "UNAUTHENTICATED" })
    await expect(requireAdmin()).rejects.toMatchObject({ code: "UNAUTHENTICATED" })
  })
  it("a session without a user id → null", async () => {
    state.session = { user: { id: "" } }
    expect(await getAuthUser()).toBeNull()
  })
})

describe("getAuthUser with a session", () => {
  it("regular user with a role → AuthUser with roleIds; requireUser returns it; requireAdmin rejects FORBIDDEN", async () => {
    const role = await db.prisma.role.create({ data: { name: "Laboratorio" } })
    const u = await makeUser(db.prisma, { username: "ana", name: "Ana", roleIds: [role.id], sessionVersion: 3 })
    signIn(u.id)
    const expected = {
      id: u.id, username: "ana", name: "Ana", isAdmin: false, roleIds: [role.id], mustChangePassword: false, sessionVersion: 3,
    }
    expect(await getAuthUser()).toEqual(expected)
    expect(await requireUser()).toEqual(expected)
    await expect(requireAdmin()).rejects.toMatchObject({ name: "DomainError", code: "FORBIDDEN" })
  })
  it("isAdmin and roleIds are read fresh from the DB on every call (not from the session)", async () => {
    const r1 = await db.prisma.role.create({ data: { name: "R-fresh-1" } })
    const r2 = await db.prisma.role.create({ data: { name: "R-fresh-2" } })
    const u = await makeUser(db.prisma, { roleIds: [r1.id] })
    signIn(u.id)
    expect(await getAuthUser()).toMatchObject({ isAdmin: false, roleIds: [r1.id] })
    await db.prisma.user.update({
      where: { id: u.id },
      data: { isAdmin: true, roles: { set: [{ id: r2.id }] }, sessionVersion: { increment: 1 } },
    })
    expect(await getAuthUser()).toMatchObject({ isAdmin: true, roleIds: [r2.id], sessionVersion: 2 })
    expect(await requireAdmin()).toMatchObject({ id: u.id, isAdmin: true })
  })
  it("admin → requireAdmin returns that user", async () => {
    const admin = await makeUser(db.prisma, { username: "admin-a", isAdmin: true })
    signIn(admin.id)
    expect(await requireAdmin()).toEqual({
      id: admin.id, username: "admin-a", name: admin.name, isAdmin: true, roleIds: [], mustChangePassword: false, sessionVersion: 1,
    })
  })
  it("mustChangePassword → PASSWORD_CHANGE_REQUIRED unless allowMustChangePassword", async () => {
    const u = await makeUser(db.prisma, { mustChangePassword: true })
    signIn(u.id)
    expect(await getAuthUser()).toMatchObject({ id: u.id, mustChangePassword: true })
    await expect(requireUser()).rejects.toMatchObject({ name: "DomainError", code: "PASSWORD_CHANGE_REQUIRED" })
    await expect(requireUser({ allowMustChangePassword: true })).resolves.toMatchObject({ id: u.id, mustChangePassword: true })
  })
  it("admin with mustChangePassword → requireAdmin rejects PASSWORD_CHANGE_REQUIRED (checked before FORBIDDEN)", async () => {
    const admin = await makeUser(db.prisma, { isAdmin: true, mustChangePassword: true })
    signIn(admin.id)
    await expect(requireAdmin()).rejects.toMatchObject({ code: "PASSWORD_CHANGE_REQUIRED" })
  })
  it("disabled user → null and UNAUTHENTICATED", async () => {
    const u = await makeUser(db.prisma, { disabled: true, isAdmin: true })
    signIn(u.id)
    expect(await getAuthUser()).toBeNull()
    await expect(requireUser()).rejects.toMatchObject({ code: "UNAUTHENTICATED" })
    await expect(requireAdmin()).rejects.toMatchObject({ code: "UNAUTHENTICATED" })
  })
  it("user disabled after sign-in → null on the next call", async () => {
    const u = await makeUser(db.prisma)
    signIn(u.id)
    expect(await getAuthUser()).not.toBeNull()
    await db.prisma.user.update({ where: { id: u.id }, data: { disabled: true } })
    expect(await getAuthUser()).toBeNull()
  })
  it("unknown or deleted user id → null and UNAUTHENTICATED", async () => {
    signIn("does-not-exist")
    expect(await getAuthUser()).toBeNull()
    await expect(requireUser()).rejects.toMatchObject({ code: "UNAUTHENTICATED" })
    const u = await makeUser(db.prisma)
    signIn(u.id)
    await db.prisma.user.delete({ where: { id: u.id } })
    expect(await getAuthUser()).toBeNull()
  })
  it("errors carry the localized message for their code", async () => {
    await expect(requireUser()).rejects.toMatchObject({ code: "UNAUTHENTICATED", message: errorMessage("UNAUTHENTICATED") })
    const u = await makeUser(db.prisma)
    signIn(u.id)
    await expect(requireAdmin()).rejects.toMatchObject({ code: "FORBIDDEN", message: errorMessage("FORBIDDEN") })
    expect(errorMessage("FORBIDDEN").length).toBeGreaterThan(0)
  })
})
