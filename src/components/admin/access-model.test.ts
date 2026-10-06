import { describe, expect, it } from "vitest"
import { RoleInputSchema } from "@/lib/contracts/users"
import {
  EMPTY_ROLE_DRAFT, equipmentOpenedByDelete, equipmentOpenedByEdit, reservationsLostByEdit, reservationsLostByUserEdit, roleDirty, roleEffect, toRoleInput, visibleEquipment,
  type EquipmentAccess, type MemberWithRoles, type ReservedEquipment,
} from "./access-model"

const eq: EquipmentAccess[] = [
  { id: "e1", name: "Equipo A #01", roleIds: ["int"] },
  { id: "e2", name: "Equipo A #02", roleIds: ["int", "val"] },
  { id: "e3", name: "Equipo C #01", roleIds: [] },
  { id: "e4", name: "Equipo B #01", roleIds: ["val"] },
]

describe("visibleEquipment", () => {
  it("admins see everything", () => {
    expect(visibleEquipment(eq, { isAdmin: true, roleIds: [] })).toMatchObject({ hidden: 0 })
  })
  it("users without roles only see equipment without roles", () => {
    const r = visibleEquipment(eq, { isAdmin: false, roleIds: [] })
    expect(r.visible.map((e) => e.id)).toEqual(["e3"])
    expect(r.hidden).toBe(3)
    expect(r.open).toBe(1)
  })
  it("a role adds its equipment", () => {
    expect(visibleEquipment(eq, { isAdmin: false, roleIds: ["val"] }).visible.map((e) => e.id)).toEqual(["e2", "e3", "e4"])
  })
})

describe("roleEffect", () => {
  it("flags equipment that had no role (new role)", () => {
    const r = roleEffect(eq, null, ["e1", "e3"], [], [])
    expect(r.restricted.map((e) => e.id)).toEqual(["e1", "e3"])
    expect(r.newlyRestricted.map((e) => e.id)).toEqual(["e3"])
  })
  it("does not flag equipment that already carries this role", () => {
    const only: EquipmentAccess[] = [{ id: "x", name: "X", roleIds: ["int"] }]
    expect(roleEffect(only, "int", ["x"], [], []).newlyRestricted).toEqual([])
  })
  it("counts admin members", () => {
    const r = roleEffect(eq, "int", [], [{ id: "a", isAdmin: true }, { id: "b", isAdmin: false }, { id: "c", isAdmin: true }], ["a", "b"])
    expect(r.adminMembers).toBe(1)
  })
})

describe("equipmentOpenedByDelete", () => {
  it("returns equipment whose only role is the deleted one", () => {
    expect(equipmentOpenedByDelete(eq, "int").map((e) => e.id)).toEqual(["e1"])
    expect(equipmentOpenedByDelete(eq, "val").map((e) => e.id)).toEqual(["e4"])
  })
})

describe("equipmentOpenedByEdit", () => {
  it("flags saved equipment removed from its only role", () => {
    expect(equipmentOpenedByEdit(eq, "int", ["e1", "e2"], ["e2"]).map((e) => e.id)).toEqual(["e1"])
  })
  it("ignores equipment that keeps another role", () => {
    expect(equipmentOpenedByEdit(eq, "int", ["e1", "e2"], ["e1"])).toEqual([])
  })
  it("ignores equipment added in the draft or never saved in the role", () => {
    expect(equipmentOpenedByEdit(eq, "int", [], ["e1"])).toEqual([])
    expect(equipmentOpenedByEdit(eq, "val", ["e4"], ["e4"])).toEqual([])
  })
  it("is empty once the draft is saved (base == draft)", () => {
    expect(equipmentOpenedByEdit(eq, "int", ["e2"], ["e2"])).toEqual([])
  })
})

describe("reservationsLostByEdit", () => {
  const res = (holderId: string) => ({ holderId, holderName: holderId.toUpperCase() })
  const reserved: ReservedEquipment[] = [
    { id: "e1", name: "Equipo A #01", roleIds: ["int"], reservation: res("laura") },
    { id: "e2", name: "Equipo A #02", roleIds: ["int", "val"], reservation: res("pablo") },
    { id: "e3", name: "Equipo C #01", roleIds: [], reservation: res("marta") },
    { id: "e4", name: "Equipo B #01", roleIds: ["val"], reservation: null },
  ]
  const members: MemberWithRoles[] = [
    { id: "laura", isAdmin: false, roleIds: ["int"] },
    { id: "pablo", isAdmin: false, roleIds: ["int", "val"] },
    { id: "marta", isAdmin: false, roleIds: [] },
    { id: "ana", isAdmin: true, roleIds: [] },
  ]
  const ids = (r: ReservedEquipment[]) => r.map((e) => e.id)

  it("releases the reservation of a member taken out of the role", () => {
    expect(ids(reservationsLostByEdit(reserved, members, "int", ["pablo"], ["e1", "e2"]))).toEqual(["e1"])
  })
  it("keeps it when another role still grants access", () => {
    expect(ids(reservationsLostByEdit(reserved, members, "int", ["laura"], ["e1", "e2"]))).toEqual([])
  })
  it("releases reservations on open equipment that gets its first role, unless the holder joins", () => {
    expect(ids(reservationsLostByEdit(reserved, members, null, ["laura"], ["e3"]))).toEqual(["e3"])
    expect(ids(reservationsLostByEdit(reserved, members, null, ["marta"], ["e3"]))).toEqual([])
  })
  it("does nothing when equipment leaves its only role (it becomes open)", () => {
    expect(ids(reservationsLostByEdit(reserved, members, "int", ["laura", "pablo"], ["e2"]))).toEqual([])
  })
  it("never releases an admin's reservation", () => {
    const adminHeld: ReservedEquipment[] = [{ id: "x", name: "X", roleIds: ["int"], reservation: res("ana") }]
    expect(reservationsLostByEdit(adminHeld, members, "int", [], [])).toEqual([])
  })
})

describe("reservationsLostByUserEdit", () => {
  const reserved: ReservedEquipment[] = [
    { id: "e1", name: "Equipo A #01", roleIds: ["int"], reservation: { holderId: "laura", holderName: "Laura" } },
    { id: "e3", name: "Equipo C #01", roleIds: [], reservation: { holderId: "laura", holderName: "Laura" } },
    { id: "e4", name: "Equipo B #01", roleIds: ["val"], reservation: { holderId: "pablo", holderName: "Pablo" } },
  ]
  it("lists this user's reservations the draft no longer shows", () => {
    expect(reservationsLostByUserEdit(reserved, "laura", { isAdmin: false, roleIds: [] }).map((e) => e.id)).toEqual(["e1"])
  })
  it("keeps them while a role or the admin flag still grants access", () => {
    expect(reservationsLostByUserEdit(reserved, "laura", { isAdmin: false, roleIds: ["int"] })).toEqual([])
    expect(reservationsLostByUserEdit(reserved, "laura", { isAdmin: true, roleIds: [] })).toEqual([])
  })
})

describe("role drafts", () => {
  it("builds a valid input (trimmed, empty description → null, unique ids)", () => {
    const input = toRoleInput({ name: " Integración ", description: "  ", userIds: ["u1", "u1"], equipmentIds: ["e1"] })
    expect(input).toEqual({ name: "Integración", description: null, userIds: ["u1"], equipmentIds: ["e1"] })
    expect(RoleInputSchema.safeParse(input).success).toBe(true)
  })
  it("dirty ignores order and whitespace", () => {
    const base = { ...EMPTY_ROLE_DRAFT, name: "A", userIds: ["1", "2"] }
    expect(roleDirty(base, { ...base, name: "A ", userIds: ["2", "1"] })).toBe(false)
    expect(roleDirty(base, { ...base, equipmentIds: ["e"] })).toBe(true)
  })
})
