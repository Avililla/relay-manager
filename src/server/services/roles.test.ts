import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import type { AuthUser } from "@/server/runtime/types"
import { createTestDb, makeUser, type TestDb } from "../../../test/helpers"
import { createRole, deleteRole, updateRole } from "./roles"
import { ctxFor, fakeDomain, resetDomainTables, toAuthUser, type FakeDomain } from "./test-fixtures"

let db: TestDb
let fx: FakeDomain
let admin: AuthUser

beforeAll(async () => { db = await createTestDb() })
afterAll(async () => { await db.cleanup() })
beforeEach(async () => {
  await resetDomainTables(db.prisma)
  fx = fakeDomain(db.prisma)
  admin = toAuthUser(await makeUser(db.prisma, { isAdmin: true }))
})

const viewerChanged = () => fx.bus.events.filter((e) => e.event.type === "viewer.changed").map((e) => e.event.type === "viewer.changed" && e.event.userId).sort()
const equipmentChanged = () => fx.bus.events.filter((e) => e.event.type === "equipment.changed").map((e) => e.event.type === "equipment.changed" && e.event.equipmentId).sort()

describe("roles service (§4.15)", () => {
  it("create connects members and equipment, publishes viewer.changed and equipment.changed, audits", async () => {
    const u1 = await makeUser(db.prisma)
    const u2 = await makeUser(db.prisma)
    const eq = await db.prisma.equipment.create({ data: { name: "EQ-1" } })
    const { id } = await createRole({ name: "Integración", description: null, userIds: [u1.id, u2.id], equipmentIds: [eq.id] }, ctxFor(fx.deps, admin))
    const role = await db.prisma.role.findUniqueOrThrow({ where: { id }, include: { users: true, equipments: true } })
    expect(role.users.map((u) => u.id).sort()).toEqual([u1.id, u2.id].sort())
    expect(role.equipments.map((e) => e.id)).toEqual([eq.id])
    expect(viewerChanged()).toEqual([u1.id, u2.id].sort())
    expect(equipmentChanged()).toEqual([eq.id])
    expect(fx.audit.inputs[0]).toMatchObject({ action: "role.create", target: { type: "role", id, name: "Integración" } })
    await expect(createRole({ name: "integración", description: null, userIds: [], equipmentIds: [] }, ctxFor(fx.deps, admin)))
      .rejects.toMatchObject({ code: "CONFLICT", fieldErrors: { name: [expect.any(String)] } })
    await expect(createRole({ name: "Otro", description: null, userIds: ["nope"], equipmentIds: [] }, ctxFor(fx.deps, admin)))
      .rejects.toMatchObject({ code: "VALIDATION", fieldErrors: { userIds: [expect.any(String)] } })
  })

  it("update notifies removed and added members and affected equipment", async () => {
    const u1 = await makeUser(db.prisma)
    const u2 = await makeUser(db.prisma)
    const u3 = await makeUser(db.prisma)
    const e1 = await db.prisma.equipment.create({ data: { name: "EQ-1" } })
    const e2 = await db.prisma.equipment.create({ data: { name: "EQ-2" } })
    const { id } = await createRole({ name: "R", description: null, userIds: [u1.id, u2.id], equipmentIds: [e1.id] }, ctxFor(fx.deps, admin))
    fx.bus.events.length = 0
    await updateRole({ roleId: id, name: "R", description: "d", userIds: [u2.id, u3.id], equipmentIds: [e1.id] }, ctxFor(fx.deps, admin))
    expect(viewerChanged()).toEqual([u1.id, u3.id].sort())
    expect(equipmentChanged()).toEqual([])
    fx.bus.events.length = 0
    await updateRole({ roleId: id, name: "R", description: "d", userIds: [u2.id, u3.id], equipmentIds: [e2.id] }, ctxFor(fx.deps, admin))
    expect(viewerChanged()).toEqual([u2.id, u3.id].sort())
    expect(equipmentChanged()).toEqual([e1.id, e2.id].sort())
    expect(fx.audit.inputs.at(-1)).toMatchObject({ action: "role.update" })
  })

  it("delete notifies its members and equipment", async () => {
    const u1 = await makeUser(db.prisma)
    const e1 = await db.prisma.equipment.create({ data: { name: "EQ-1" } })
    const { id } = await createRole({ name: "R", description: null, userIds: [u1.id], equipmentIds: [e1.id] }, ctxFor(fx.deps, admin))
    fx.bus.events.length = 0
    await deleteRole({ roleId: id }, ctxFor(fx.deps, admin))
    expect(await db.prisma.role.count()).toBe(0)
    expect(viewerChanged()).toEqual([u1.id])
    expect(equipmentChanged()).toEqual([e1.id])
    await expect(deleteRole({ roleId: id }, ctxFor(fx.deps, admin))).rejects.toMatchObject({ code: "NOT_FOUND" })
  })
})
