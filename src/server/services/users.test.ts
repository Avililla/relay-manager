import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { CreateUserInputSchema } from "@/lib/contracts/users"
import { verifyPassword } from "@/server/auth/passwords"
import type { AuthUser, ReservationService } from "@/server/runtime/types"
import { createTestDb, fakeReservations, makeUser, type TestDb } from "../../../test/helpers"
import { createUser, deleteUser, resetUserPassword, setUserDisabled, updateUser } from "./users"
import { ctxFor, fakeDomain, resetDomainTables, toAuthUser, type FakeDomain } from "./test-fixtures"

let db: TestDb
let fx: FakeDomain
let admin: AuthUser
let released: Array<[string, string]>

beforeAll(async () => { db = await createTestDb() })
afterAll(async () => { await db.cleanup() })
beforeEach(async () => {
  await resetDomainTables(db.prisma)
  released = []
  const base = fakeReservations()
  const reservations: ReservationService = {
    ...base,
    async releaseAllForUser(userId, cause) { released.push([userId, cause]); return 0 },
  }
  fx = fakeDomain(db.prisma, { reservations })
  admin = toAuthUser(await makeUser(db.prisma, { username: "jefa", name: "Jefa", isAdmin: true }))
})

const sv = async (id: string) => (await db.prisma.user.findUniqueOrThrow({ where: { id } })).sessionVersion
const events = (type: string) => fx.bus.events.filter((e) => e.event.type === type)

describe("users service (§4.15)", () => {
  it("create hashes the password (never audited), validates roles and refuses duplicate usernames", async () => {
    const role = await db.prisma.role.create({ data: { name: "Integración" } })
    const input = CreateUserInputSchema.parse({ username: "Ana.Perez", name: "Ana", password: "una-clave-larga", roleIds: [role.id] })
    const { id } = await createUser(input, ctxFor(fx.deps, admin))
    const u = await db.prisma.user.findUniqueOrThrow({ where: { id }, include: { roles: true } })
    expect(u.username).toBe("ana.perez")
    expect(u.mustChangePassword).toBe(true)
    expect(await verifyPassword("una-clave-larga", u.passwordHash)).toBe(true)
    expect(u.roles.map((r) => r.id)).toEqual([role.id])
    expect(fx.audit.inputs[0]).toMatchObject({ action: "user.create", target: { type: "user", id, name: "ana.perez" } })
    expect(JSON.stringify(fx.audit.inputs)).not.toContain("una-clave-larga")
    await expect(createUser(input, ctxFor(fx.deps, admin))).rejects.toMatchObject({ code: "CONFLICT", fieldErrors: { username: [expect.any(String)] } })
    await expect(createUser({ ...input, username: "otra", roleIds: ["nope"] }, ctxFor(fx.deps, admin)))
      .rejects.toMatchObject({ code: "VALIDATION", fieldErrors: { roleIds: [expect.any(String)] } })
  })

  it("role and admin changes publish viewer.changed and never bump sessionVersion", async () => {
    const role = await db.prisma.role.create({ data: { name: "Integración" } })
    const u = await makeUser(db.prisma, { name: "Ana" })
    await updateUser({ userId: u.id, name: "Ana P.", email: null, isAdmin: true, roleIds: [role.id] }, ctxFor(fx.deps, admin))
    expect(await sv(u.id)).toBe(1)
    expect(events("viewer.changed").map((e) => e.event)).toEqual([{ type: "viewer.changed", userId: u.id }])
    expect(events("viewer.changed")[0].audience).toEqual({ kind: "user", userId: u.id })
    expect(events("session.revoked")).toEqual([])
    expect(fx.audit.inputs[0]).toMatchObject({ action: "user.update", detail: { changed: { name: ["Ana", "Ana P."], isAdmin: [false, true] }, roles: { before: [], after: ["Integración"] } } })
    fx.bus.events.length = 0
    await updateUser({ userId: u.id, name: "Ana P.", email: "ana@lab.local", isAdmin: true, roleIds: [role.id] }, ctxFor(fx.deps, admin))
    expect(events("viewer.changed")).toEqual([])
  })

  it("last-admin rules: no demote, disable or delete of the last enabled admin", async () => {
    await expect(updateUser({ userId: admin.id, name: "Jefa", email: null, isAdmin: false, roleIds: [] }, ctxFor(fx.deps, toAuthUser(await makeUser(db.prisma, { isAdmin: false })))))
      .rejects.toMatchObject({ code: "LAST_ADMIN" })
    const other = toAuthUser(await makeUser(db.prisma, { name: "Otra", isAdmin: true }))
    // two admins: one may be demoted, then the remaining one is the last
    await updateUser({ userId: other.id, name: "Otra", email: null, isAdmin: false, roleIds: [] }, ctxFor(fx.deps, admin))
    await expect(setUserDisabled({ userId: admin.id, disabled: true }, ctxFor(fx.deps, other))).rejects.toMatchObject({ code: "LAST_ADMIN" })
    await expect(deleteUser({ userId: admin.id }, ctxFor(fx.deps, other))).rejects.toMatchObject({ code: "LAST_ADMIN" })
    // a disabled admin does not count as enabled
    const disabledAdmin = await makeUser(db.prisma, { isAdmin: true, disabled: true })
    await expect(updateUser({ userId: admin.id, name: "Jefa", email: null, isAdmin: false, roleIds: [] }, ctxFor(fx.deps, other)))
      .rejects.toMatchObject({ code: "LAST_ADMIN" })
    await deleteUser({ userId: disabledAdmin.id }, ctxFor(fx.deps, admin))
  })

  it("users cannot disable or delete themselves", async () => {
    await makeUser(db.prisma, { isAdmin: true })
    // The specific reason is the message (not the generic "Revisa los campos marcados.") and the _form error.
    await expect(setUserDisabled({ userId: admin.id, disabled: true }, ctxFor(fx.deps, admin))).rejects.toMatchObject({
      code: "VALIDATION", message: "No puedes desactivar tu propio usuario", fieldErrors: { _form: ["No puedes desactivar tu propio usuario"] } })
    await expect(deleteUser({ userId: admin.id }, ctxFor(fx.deps, admin))).rejects.toMatchObject({
      code: "VALIDATION", message: "No puedes borrar tu propio usuario", fieldErrors: { _form: ["No puedes borrar tu propio usuario"] } })
  })

  it("disable bumps sessionVersion, releases reservations and publishes session.revoked; enable does not bump", async () => {
    const u = await makeUser(db.prisma)
    await setUserDisabled({ userId: u.id, disabled: true }, ctxFor(fx.deps, admin))
    expect(await sv(u.id)).toBe(2)
    expect(released).toEqual([[u.id, "user-disabled"]])
    expect(events("session.revoked")[0]).toEqual({ event: { type: "session.revoked", userId: u.id, reason: "disabled" }, audience: { kind: "user", userId: u.id } })
    await setUserDisabled({ userId: u.id, disabled: false }, ctxFor(fx.deps, admin))
    expect(await sv(u.id)).toBe(2)
    expect(fx.audit.inputs.map((i) => i.action)).toEqual(["user.disable", "user.enable"])
  })

  it("password reset bumps sessionVersion, sets mustChangePassword and publishes session.revoked", async () => {
    const u = await makeUser(db.prisma)
    await resetUserPassword({ userId: u.id, password: "otra-clave-nueva", mustChangePassword: true }, ctxFor(fx.deps, admin))
    const row = await db.prisma.user.findUniqueOrThrow({ where: { id: u.id } })
    expect([row.sessionVersion, row.mustChangePassword]).toEqual([2, true])
    expect(await verifyPassword("otra-clave-nueva", row.passwordHash)).toBe(true)
    expect(events("session.revoked")[0].event).toMatchObject({ reason: "password-changed" })
    expect(fx.audit.inputs[0]).toMatchObject({ action: "user.password.reset" })
    expect(JSON.stringify(fx.audit.inputs)).not.toContain("otra-clave-nueva")
  })

  it("delete releases the reservations first and publishes session.revoked", async () => {
    const u = await makeUser(db.prisma)
    await deleteUser({ userId: u.id }, ctxFor(fx.deps, admin))
    expect(await db.prisma.user.count({ where: { id: u.id } })).toBe(0)
    expect(released).toEqual([[u.id, "user-deleted"]])
    expect(events("session.revoked")[0].event).toMatchObject({ userId: u.id, reason: "deleted" })
    expect(fx.audit.inputs[0]).toMatchObject({ action: "user.delete", target: { id: u.id, name: u.username } })
    await expect(deleteUser({ userId: u.id }, ctxFor(fx.deps, admin))).rejects.toMatchObject({ code: "NOT_FOUND" })
  })
})
