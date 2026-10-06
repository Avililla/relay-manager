import { describe, expect, it } from "vitest"
import { PASSWORD_CHANGED_KEY, clearPasswordChanged, isChangingOwnPassword, markPasswordChanged, takePasswordChanged, type FlagStorage } from "./password-changed-flag"

function mem(): FlagStorage & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  }
}

describe("password-changed flag", () => {
  it("round-trips once", () => {
    const s = mem()
    markPasswordChanged("operador", s, 1000)
    expect(takePasswordChanged(s, 2000)).toBe("operador")
    expect(s.data.has(PASSWORD_CHANGED_KEY)).toBe(false)
    expect(takePasswordChanged(s, 2000)).toBeNull()
  })

  it("expires after ten minutes", () => {
    const s = mem()
    markPasswordChanged("operador", s, 0)
    expect(takePasswordChanged(s, 10 * 60_000 + 1)).toBeNull()
  })

  it("rejects malformed or foreign values", () => {
    const s = mem()
    s.setItem(PASSWORD_CHANGED_KEY, "not json")
    expect(takePasswordChanged(s, 0)).toBeNull()
    s.setItem(PASSWORD_CHANGED_KEY, JSON.stringify({ u: "<script>", at: 0 }))
    expect(takePasswordChanged(s, 0)).toBeNull()
    s.setItem(PASSWORD_CHANGED_KEY, JSON.stringify({ u: "ok.user", at: "0" }))
    expect(takePasswordChanged(s, 0)).toBeNull()
  })

  it("survives missing or throwing storage", () => {
    expect(takePasswordChanged(null)).toBeNull()
    const throwing: FlagStorage = {
      getItem: () => { throw new Error("blocked") },
      setItem: () => { throw new Error("blocked") },
      removeItem: () => { throw new Error("blocked") },
    }
    expect(() => markPasswordChanged("a1", throwing)).not.toThrow()
    expect(() => clearPasswordChanged(throwing)).not.toThrow()
    expect(takePasswordChanged(throwing)).toBeNull()
  })
})

describe("isChangingOwnPassword (this tab is re-signing in after its own password change)", () => {
  it("is true for a fresh flag and leaves it in place for the login page", () => {
    const s = mem()
    markPasswordChanged("operador", s, 1000)
    expect(isChangingOwnPassword(s, 5000)).toBe(true)
    expect(s.data.has(PASSWORD_CHANGED_KEY)).toBe(true)
  })
  it("is false without a flag, after a minute, or with blocked storage", () => {
    const s = mem()
    expect(isChangingOwnPassword(s, 0)).toBe(false)
    markPasswordChanged("operador", s, 0)
    expect(isChangingOwnPassword(s, 60_001)).toBe(false)
    expect(isChangingOwnPassword(null, 0)).toBe(false)
    const throwing: FlagStorage = { getItem: () => { throw new Error("blocked") }, setItem: () => {}, removeItem: () => {} }
    expect(isChangingOwnPassword(throwing, 0)).toBe(false)
  })
})
