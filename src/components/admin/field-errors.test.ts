import { describe, expect, it } from "vitest"
import { z } from "zod"
import { ChangeOwnPasswordInputSchema, CreateUserInputSchema, RoleInputSchema, SetupInputSchema } from "@/lib/contracts/users"
import { SPANISH_PARSE, mergeFieldErrors, spanishIssue, withoutField, zodFieldErrors } from "./field-errors"

describe("zodFieldErrors", () => {
  it("keys by the full dotted path and uses _form for root issues", () => {
    const s = z.object({ a: z.array(z.object({ b: z.string().min(2, "corto") })) }).refine(() => false, "raíz")
    const r = s.safeParse({ a: [{ b: "ok" }, { b: "x" }] })
    expect(r.success).toBe(false)
    if (!r.success) expect(zodFieldErrors(r.error)).toEqual({ "a.1.b": ["corto"], _form: ["raíz"] })
    const r2 = s.safeParse({ a: [] })
    if (!r2.success) expect(zodFieldErrors(r2.error)).toEqual({ _form: ["raíz"] })
  })

  it("reports the setup refinements on their fields", () => {
    const r = SetupInputSchema.safeParse({ token: "W2D0-W2D0", username: "admin", name: "Ana", password: "clave-segura-1", passwordConfirm: "otra" })
    expect(r.success).toBe(false)
    if (!r.success) expect(zodFieldErrors(r.error).passwordConfirm).toEqual(["Las contraseñas no coinciden"])
  })
})

describe("mergeFieldErrors", () => {
  it("prefers the first source per key and drops empty lists", () => {
    expect(mergeFieldErrors({ a: ["servidor"], b: [] }, { a: ["local"], c: ["local c"] }, null)).toEqual({ a: ["servidor"], c: ["local c"] })
  })
})

describe("withoutField", () => {
  it("removes one key and keeps identity when absent", () => {
    const e = { a: ["x"], b: ["y"] }
    expect(withoutField(e, "a")).toEqual({ b: ["y"] })
    expect(withoutField(e, "z")).toBe(e)
  })
})

describe("spanishIssue", () => {
  it("replaces zod's English defaults in the admin forms", () => {
    const r = CreateUserInputSchema.safeParse({ username: "ana", name: "  ", email: "no-es-un-correo", password: "clave-segura-1" }, SPANISH_PARSE)
    expect(r.success).toBe(false)
    if (!r.success) {
      const fe = zodFieldErrors(r.error)
      expect(fe.name).toEqual(["Obligatorio"])
      expect(fe.email).toEqual(["Correo electrónico no válido"])
    }
  })
  it("keeps the contracts' own Spanish messages", () => {
    const r = SetupInputSchema.safeParse({ token: "abc", username: "", name: "", password: "", passwordConfirm: "x" }, SPANISH_PARSE)
    expect(r.success).toBe(false)
    if (!r.success) {
      const fe = zodFieldErrors(r.error)
      expect(fe.token).toEqual(["Mínimo 8 caracteres"])
      expect(fe.name).toEqual(["Obligatorio"])
      expect(fe.password).toContain("Mínimo 10 caracteres")
      expect(fe.username?.[0]).toMatch(/^De 2 a 32 caracteres/)
    }
    const c = ChangeOwnPasswordInputSchema.safeParse({ currentPassword: "", newPassword: "clave-segura-1", confirmPassword: "clave-segura-1" }, SPANISH_PARSE)
    expect(c.success).toBe(false)
    if (!c.success) expect(zodFieldErrors(c.error).currentPassword).toEqual(["Obligatorio"])
    const role = RoleInputSchema.safeParse({ name: "x".repeat(41), description: null, userIds: [], equipmentIds: [] }, SPANISH_PARSE)
    expect(role.success).toBe(false)
    if (!role.success) expect(zodFieldErrors(role.error).name).toEqual(["Máximo 40 caracteres"])
  })
  it("never returns English for the other codes", () => {
    expect(spanishIssue({ code: "invalid_type", input: undefined })).toBe("Obligatorio")
    expect(spanishIssue({ code: "invalid_type", input: 3 })).toBe("Valor no válido")
    expect(spanishIssue({ code: "invalid_format", format: "uuid" })).toBe("Formato no válido")
    expect(spanishIssue({ code: "too_big", origin: "array", maximum: 50 })).toBe("Máximo 50")
    expect(spanishIssue({ code: "custom" })).toBe("Valor no válido")
  })
})
