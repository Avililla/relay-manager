import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createTestDb, type TestDb } from "../../test/helpers"
import { consoleForUser, equipmentForUser, visibleEquipmentIdsFor } from "./access"

let db: TestDb
let ids: { open: string; restricted: string; console: string; r1: string; r2: string }

beforeAll(async () => {
  db = await createTestDb()
  const r1 = await db.prisma.role.create({ data: { name: "R1" } })
  const r2 = await db.prisma.role.create({ data: { name: "R2" } })
  const open = await db.prisma.equipment.create({ data: { name: "Libre" } })
  const restricted = await db.prisma.equipment.create({ data: { name: "Restringido", roles: { connect: [{ id: r1.id }] } } })
  const c = await db.prisma.serialConsole.create({ data: { equipmentId: restricted.id, position: 0, key: "UART0", label: "UART0" } })
  ids = { open: open.id, restricted: restricted.id, console: c.id, r1: r1.id, r2: r2.id }
})
afterAll(async () => { await db.cleanup() })

describe("equipmentForUser", () => {
  it("admin sees restricted equipment", async () => {
    expect(await equipmentForUser(db.prisma, { isAdmin: true, roleIds: [] }, ids.restricted)).toEqual({ id: ids.restricted, name: "Restringido" })
  })
  it("equipment without roles is visible", async () => {
    expect(await equipmentForUser(db.prisma, { isAdmin: false, roleIds: [] }, ids.open)).toEqual({ id: ids.open, name: "Libre" })
  })
  it("intersecting role → visible; disjoint → null", async () => {
    expect(await equipmentForUser(db.prisma, { isAdmin: false, roleIds: [ids.r1] }, ids.restricted)).not.toBeNull()
    expect(await equipmentForUser(db.prisma, { isAdmin: false, roleIds: [ids.r2] }, ids.restricted)).toBeNull()
  })
  it("missing → null", async () => {
    expect(await equipmentForUser(db.prisma, { isAdmin: true, roleIds: [] }, "nope")).toBeNull()
  })
})

describe("consoleForUser", () => {
  it("returns the console with its equipment when visible", async () => {
    expect(await consoleForUser(db.prisma, { isAdmin: false, roleIds: [ids.r1] }, ids.console)).toEqual({
      id: ids.restricted, name: "Restringido", consoleId: ids.console, key: "UART0", label: "UART0",
    })
  })
  it("invisible and missing are both null", async () => {
    expect(await consoleForUser(db.prisma, { isAdmin: false, roleIds: [ids.r2] }, ids.console)).toBeNull()
    expect(await consoleForUser(db.prisma, { isAdmin: true, roleIds: [] }, "missing")).toBeNull()
  })
})

describe("visibleEquipmentIdsFor", () => {
  it("admins get 'all'", async () => {
    expect(await visibleEquipmentIdsFor(db.prisma, { isAdmin: true, roleIds: [] })).toBe("all")
  })
  it("users get equipment without roles plus intersecting ones", async () => {
    expect(new Set(await visibleEquipmentIdsFor(db.prisma, { isAdmin: false, roleIds: [] }))).toEqual(new Set([ids.open]))
    expect(new Set(await visibleEquipmentIdsFor(db.prisma, { isAdmin: false, roleIds: [ids.r1] }))).toEqual(new Set([ids.open, ids.restricted]))
  })
})
