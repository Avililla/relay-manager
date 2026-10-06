import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { setRuntime } from "@/server/runtime/registry"
import type { Runtime } from "@/server/runtime/types"
import { resetDomainTables } from "@/server/services/test-fixtures"
import { createTestDb, fakeReservations, fakeRuntime, makeUser, type TestDb } from "../../../test/helpers"
import { getUser, listRoles, listUsers } from "./users"

let db: TestDb
let rt: Runtime

beforeAll(async () => { db = await createTestDb() })
afterAll(async () => { await db.cleanup() })
beforeEach(async () => {
  await resetDomainTables(db.prisma)
  rt = fakeRuntime({ prisma: db.prisma })
  setRuntime(rt)
})

describe("users queries (§7.4)", () => {
  it("isLastEnabledAdmin and activeReservations", async () => {
    const a = await makeUser(db.prisma, { name: "Ana", isAdmin: true })
    const b = await makeUser(db.prisma, { name: "Berta", isAdmin: true, disabled: true })
    const c = await makeUser(db.prisma, { name: "Carla" })
    const eq = await db.prisma.equipment.create({ data: { name: "EQ" } })
    rt.reservations = fakeReservations({ holders: { [eq.id]: c.id } })
    const list = await listUsers()
    expect(list.map((x) => [x.name, x.isLastEnabledAdmin, x.activeReservations])).toEqual([["Ana", true, 0], ["Berta", false, 0], ["Carla", false, 1]])
    await db.prisma.user.update({ where: { id: b.id }, data: { disabled: false } })
    expect((await getUser(a.id))?.isLastEnabledAdmin).toBe(false)
    expect(await getUser("nope")).toBeNull()
  })

  it("listRoles with members and equipment", async () => {
    const a = await makeUser(db.prisma, { name: "Ana" })
    const eq = await db.prisma.equipment.create({ data: { name: "EQ" } })
    await db.prisma.role.create({ data: { name: "Integración", users: { connect: [{ id: a.id }] }, equipments: { connect: [{ id: eq.id }] } } })
    expect(await listRoles()).toEqual([expect.objectContaining({ name: "Integración", userCount: 1, equipmentCount: 1, equipments: [{ id: eq.id, name: "EQ" }] })])
  })
})
