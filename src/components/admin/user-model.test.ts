import { describe, expect, it } from "vitest"
import { CreateUserInputSchema, UpdateUserInputSchema, type UserDTO } from "@/lib/contracts/users"
import {
  EMPTY_USER_DRAFT, toCreateUserInput, toUpdateUserInput, userCreateDirty, userDraftFrom, userEditDirty, userProtections, userStatus,
} from "./user-model"

const dto = (over: Partial<UserDTO> = {}): UserDTO => ({
  id: "u1", username: "operador", name: "Lucía Ferrer", email: null, isAdmin: false, disabled: false, mustChangePassword: false,
  isLastEnabledAdmin: false, roles: [{ id: "r1", name: "Integración" }], lastLoginAt: null, createdAt: "2026-09-23T10:00:00.000Z",
  activeReservations: 0, ...over,
})

describe("userStatus", () => {
  it("prefers disabled over must-change", () => {
    expect(userStatus(dto())).toBe("active")
    expect(userStatus(dto({ mustChangePassword: true }))).toBe("mustChange")
    expect(userStatus(dto({ mustChangePassword: true, disabled: true }))).toBe("disabled")
  })
})

describe("userProtections", () => {
  it("blocks disable and delete for yourself, but not demote", () => {
    const p = userProtections(dto({ id: "me" }), "me")
    expect(p).toMatchObject({ canDisable: false, canDelete: false, canDemote: true })
    expect(p.blockedReason).toMatch(/propia cuenta/)
  })
  it("blocks everything for the last enabled admin", () => {
    const p = userProtections(dto({ isAdmin: true, isLastEnabledAdmin: true }), "someone-else")
    expect(p).toMatchObject({ canDisable: false, canDelete: false, canDemote: false })
    expect(p.blockedReason).toMatch(/último administrador/)
  })
  it("allows everything otherwise", () => {
    expect(userProtections(dto(), "admin")).toEqual({ canDisable: true, canDelete: true, canDemote: true, blockedReason: null })
  })
})

describe("drafts", () => {
  it("builds a valid create input (trimmed, lowercase, empty email → null, unique roles)", () => {
    const input = toCreateUserInput({
      ...EMPTY_USER_DRAFT, username: " Operador.2 ", name: " Lucía ", email: "  ", password: "clave-temporal-1", roleIds: ["r1", "r1"],
    })
    expect(input).toEqual({ username: "operador.2", name: "Lucía", email: null, password: "clave-temporal-1", isAdmin: false, roleIds: ["r1"], mustChangePassword: true })
    expect(CreateUserInputSchema.safeParse(input).success).toBe(true)
  })

  it("builds a valid update input from a DTO round trip", () => {
    const d = userDraftFrom(dto({ email: "lucia@lab.local" }))
    const input = toUpdateUserInput("u1", d)
    expect(input).toEqual({ userId: "u1", name: "Lucía Ferrer", email: "lucia@lab.local", isAdmin: false, roleIds: ["r1"] })
    expect(UpdateUserInputSchema.safeParse(input).success).toBe(true)
  })

  it("edit dirty ignores role order, whitespace and the unused password", () => {
    const base = userDraftFrom(dto({ roles: [{ id: "a", name: "A" }, { id: "b", name: "B" }] }))
    expect(userEditDirty(base, { ...base, roleIds: ["b", "a"], name: "Lucía Ferrer ", password: "x" })).toBe(false)
    expect(userEditDirty(base, { ...base, isAdmin: true })).toBe(true)
    expect(userEditDirty(base, { ...base, roleIds: ["a"] })).toBe(true)
    expect(userEditDirty(base, { ...base, email: "x@y.es" })).toBe(true)
  })

  it("create dirty turns on with any input", () => {
    expect(userCreateDirty(EMPTY_USER_DRAFT)).toBe(false)
    expect(userCreateDirty({ ...EMPTY_USER_DRAFT, name: "L" })).toBe(true)
    expect(userCreateDirty({ ...EMPTY_USER_DRAFT, mustChangePassword: false })).toBe(true)
  })
})
