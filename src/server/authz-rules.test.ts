import { describe, expect, it } from "vitest"
import { canControl, canSeeEquipment, canWriteConsoleEquipment } from "./authz-rules"
import type { ReservationDTO } from "@/lib/contracts/reservations"

const res = (holderId: string): ReservationDTO => ({
  equipmentId: "e1", holderId, holderName: holderId, holderUsername: holderId,
  reservedAt: "2026-09-23T10:00:00.000Z", expiresAt: "2026-09-23T10:30:00.000Z", note: null,
})

describe("canSeeEquipment", () => {
  it("admin sees everything", () => expect(canSeeEquipment({ isAdmin: true, roleIds: [] }, ["r1"])).toBe(true))
  it("equipment without roles is visible to everyone", () => expect(canSeeEquipment({ isAdmin: false, roleIds: [] }, [])).toBe(true))
  it("intersecting roles are visible", () => expect(canSeeEquipment({ isAdmin: false, roleIds: ["r2", "r1"] }, ["r1"])).toBe(true))
  it("disjoint roles are not visible", () => expect(canSeeEquipment({ isAdmin: false, roleIds: ["r2"] }, ["r1"])).toBe(false))
})

describe("canControl", () => {
  it("only the holder controls", () => {
    expect(canControl({ id: "u1" }, res("u1"))).toBe(true)
    expect(canControl({ id: "u2" }, res("u1"))).toBe(false)
    expect(canControl({ id: "u1" }, null)).toBe(false)
  })
})

describe("canWriteConsoleEquipment", () => {
  it("holder → ok", () => expect(canWriteConsoleEquipment(res("u1"), { id: "u1", isAdmin: false })).toBe("ok"))
  it("admin holder → ok", () => expect(canWriteConsoleEquipment(res("a1"), { id: "a1", isAdmin: true })).toBe("ok"))
  it("admin on a free unit → ok", () => expect(canWriteConsoleEquipment(null, { id: "a1", isAdmin: true })).toBe("ok"))
  it("admin under another holder → RESERVED_BY_OTHER", () => expect(canWriteConsoleEquipment(res("u1"), { id: "a1", isAdmin: true })).toBe("RESERVED_BY_OTHER"))
  it("other user → NOT_HOLDER", () => {
    expect(canWriteConsoleEquipment(res("u1"), { id: "u2", isAdmin: false })).toBe("NOT_HOLDER")
    expect(canWriteConsoleEquipment(null, { id: "u2", isAdmin: false })).toBe("NOT_HOLDER")
  })
})
