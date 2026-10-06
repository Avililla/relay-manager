import { describe, expect, it } from "vitest"
import { PasswordSchema } from "@/lib/contracts/users"
import { checkPassword, confirmationMatches, passwordBytes, withoutRuleMessages } from "./password-rules"

const ok = (p: string, u = "") => Object.fromEntries(checkPassword(p, u).rules.map((r) => [r.id, r.ok]))

describe("checkPassword", () => {
  it("meets nothing while empty", () => {
    expect(ok("")).toEqual({ min: false, max: false, user: false })
    expect(checkPassword("").ok).toBe(false)
  })

  it("needs 10 characters", () => {
    expect(ok("123456789").min).toBe(false)
    expect(ok("1234567890").min).toBe(true)
  })

  it("counts UTF-8 bytes for the 72-byte limit", () => {
    expect(passwordBytes("ñ")).toBe(2)
    expect(ok("a".repeat(72)).max).toBe(true)
    expect(ok("a".repeat(73)).max).toBe(false)
    expect(ok("ñ".repeat(36)).max).toBe(true)
    expect(ok("ñ".repeat(37)).max).toBe(false)
  })

  it("refuses the username, case-insensitively and trimmed", () => {
    expect(ok("operador01", "operador01").user).toBe(false)
    expect(ok("OPERADOR01", " operador01 ").user).toBe(false)
    expect(ok("operador01!", "operador01").user).toBe(true)
    expect(ok("cualquiera123", "").user).toBe(true)
  })

  it("agrees with the contract schema on the length rules", () => {
    for (const p of ["short", "1234567890", "ñ".repeat(37), "a".repeat(72), "a".repeat(73), "contraseña-larga"]) {
      const { rules } = checkPassword(p)
      const lengthOk = rules.filter((r) => r.id !== "user").every((r) => r.ok)
      expect(lengthOk).toBe(PasswordSchema.safeParse(p).success)
    }
  })

  it("is ok only when every rule holds", () => {
    expect(checkPassword("laboratorio-2026", "admin").ok).toBe(true)
    expect(checkPassword("admin12345", "admin12345").ok).toBe(false)
  })
})

describe("confirmationMatches", () => {
  it("is null while the confirmation is empty", () => {
    expect(confirmationMatches("abc", "")).toBeNull()
  })
  it("compares exactly", () => {
    expect(confirmationMatches("abc", "abc")).toBe(true)
    expect(confirmationMatches("abc", "abC")).toBe(false)
  })
})

describe("withoutRuleMessages", () => {
  it("drops exactly the contract messages the rules list covers", () => {
    const r = PasswordSchema.safeParse("x")
    const msgs = r.success ? [] : r.error.issues.map((i) => i.message)
    expect(msgs.length).toBeGreaterThan(0)
    expect(withoutRuleMessages([...msgs, "La contraseña no puede ser el nombre de usuario", "La contraseña actual no es correcta"]))
      .toEqual(["La contraseña actual no es correcta"])
  })
})
