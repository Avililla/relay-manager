import { describe, expect, it } from "vitest"
import { PasswordSchema } from "@/lib/contracts/users"
import { PASSWORD_ALPHABET, generatePassword } from "./generate-password"

describe("generatePassword", () => {
  it("builds four dash-separated groups from the unambiguous alphabet", () => {
    const p = generatePassword()
    expect(p).toMatch(/^[^-]{4}-[^-]{4}-[^-]{4}-[^-]{4}$/)
    for (const ch of p.replaceAll("-", "")) expect(PASSWORD_ALPHABET).toContain(ch)
    expect(PASSWORD_ALPHABET).not.toMatch(/[0O1lI]/)
  })

  it("always satisfies the password contract", () => {
    for (let i = 0; i < 50; i++) expect(PasswordSchema.safeParse(generatePassword()).success).toBe(true)
  })

  it("skips biased bytes (rejection sampling)", () => {
    const n = PASSWORD_ALPHABET.length
    const limit = 256 - (256 % n)
    // First byte is above the limit and must be skipped; then 0, 1, 2… map to the first letters.
    let calls = 0
    const rnd = (len: number) => {
      calls++
      const out = new Uint8Array(len)
      out[0] = limit
      for (let i = 1; i < len; i++) out[i] = (i - 1) % n
      return out
    }
    const p = generatePassword(rnd, 1, 4)
    expect(p).toBe(PASSWORD_ALPHABET.slice(0, 4))
    expect(calls).toBe(1)
  })

  it("keeps asking for bytes until it has enough", () => {
    let calls = 0
    const rnd = (len: number) => {
      calls++
      return new Uint8Array(len).fill(calls < 3 ? 255 : 7)
    }
    expect(generatePassword(rnd, 1, 4)).toBe(PASSWORD_ALPHABET[7].repeat(4))
    expect(calls).toBe(3)
  })
})
