import { describe, expect, it, vi } from "vitest"
import type { ActionResult } from "@/lib/contracts/common"
import type { PrefStorage } from "./prefs"
import { THEME_ACCOUNT_KEY, THEME_KEY, type ThemePref } from "./theme"
import { adoptStoredTheme, cacheAccountTheme, changeAccountTheme, readStoredTheme } from "./theme-account"

function memoryStorage(init: Record<string, string> = {}): PrefStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(init))
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => { data.set(k, v) },
    removeItem: (k) => { data.delete(k) },
  }
}
const ok: ActionResult<{ theme: ThemePref }> = { ok: true, data: { theme: "rosa" } }
const failed: ActionResult<{ theme: ThemePref }> = { ok: false, error: { code: "INTERNAL", message: "Error interno (ref 1234)" } }

describe("cacheAccountTheme / readStoredTheme", () => {
  it("writes the theme and marks it as the account's", () => {
    const s = memoryStorage()
    cacheAccountTheme("rosa", s)
    expect(Object.fromEntries(s.data)).toEqual({ [THEME_KEY]: "rosa", [THEME_ACCOUNT_KEY]: "1" })
    expect(readStoredTheme(s)).toEqual({ stored: "rosa", marked: true })
  })
  it("a legacy value is not marked; blocked storage reads as empty and never throws", () => {
    expect(readStoredTheme(memoryStorage({ [THEME_KEY]: "light" }))).toEqual({ stored: "light", marked: false })
    const blocked: PrefStorage = { getItem: () => { throw new Error("SecurityError") }, setItem: () => { throw new Error("QuotaExceeded") }, removeItem: () => {} }
    expect(readStoredTheme(blocked)).toEqual({ stored: null, marked: false })
    expect(() => cacheAccountTheme("dark", blocked)).not.toThrow()
    expect(readStoredTheme(null)).toEqual({ stored: null, marked: false })
  })
})

describe("adoptStoredTheme (first login after the upgrade)", () => {
  it("an account without a theme adopts the browser's legacy choice once and marks it", async () => {
    const s = memoryStorage({ [THEME_KEY]: "rosa" })
    const save = vi.fn(async () => ok)
    expect(await adoptStoredTheme(null, { storage: s, save })).toBe("rosa")
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith("rosa")
    expect(s.data.get(THEME_ACCOUNT_KEY)).toBe("1")
    // Next page load: the value is marked, nothing is adopted again.
    expect(await adoptStoredTheme(null, { storage: s, save })).toBeNull()
    expect(save).toHaveBeenCalledTimes(1)
  })
  it("never adopts another account's cached theme, and never overrides the account's own choice", async () => {
    const save = vi.fn(async () => ok)
    expect(await adoptStoredTheme(null, { storage: memoryStorage({ [THEME_KEY]: "rosa", [THEME_ACCOUNT_KEY]: "1" }), save })).toBeNull()
    expect(await adoptStoredTheme("light", { storage: memoryStorage({ [THEME_KEY]: "rosa" }), save })).toBeNull()
    expect(await adoptStoredTheme(null, { storage: memoryStorage(), save })).toBeNull()
    expect(await adoptStoredTheme(null, { storage: memoryStorage({ [THEME_KEY]: "sepia" }), save })).toBeNull()
    expect(save).not.toHaveBeenCalled()
  })
  it("a failed or thrown save leaves the value unmarked, so the next load tries again", async () => {
    const s = memoryStorage({ [THEME_KEY]: "light" })
    expect(await adoptStoredTheme(null, { storage: s, save: async () => failed })).toBeNull()
    expect(await adoptStoredTheme(null, { storage: s, save: async () => { throw new Error("offline") } })).toBeNull()
    expect(s.data.has(THEME_ACCOUNT_KEY)).toBe(false)
  })
})

describe("changeAccountTheme (optimistic)", () => {
  function deps(start: ThemePref, save: (p: ThemePref) => Promise<ActionResult<unknown>>) {
    let current = start
    const applied: ThemePref[] = []
    return {
      applied,
      get current() { return current },
      d: {
        current: () => current,
        apply: (p: ThemePref) => { current = p; applied.push(p) },
        save,
      },
    }
  }
  it("applies at once and saves in the account", async () => {
    let resolveSave: (r: ActionResult<unknown>) => void = () => {}
    const t = deps("dark", () => new Promise((r) => { resolveSave = r }))
    const p = changeAccountTheme("rosa", t.d)
    expect(t.current).toBe("rosa") // before the server answered
    resolveSave(ok)
    expect(await p).toEqual({ ok: true })
    expect(t.applied).toEqual(["rosa"])
  })
  it("the same theme does nothing", async () => {
    const save = vi.fn(async () => ok)
    const t = deps("rosa", save)
    expect(await changeAccountTheme("rosa", t.d)).toEqual({ ok: true })
    expect(save).not.toHaveBeenCalled()
    expect(t.applied).toEqual([])
  })
  it("a failure reverts to the previous theme and returns a Spanish message", async () => {
    const t = deps("light", async () => failed)
    const r = await changeAccountTheme("rosa", t.d)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.message).toMatch(/No se ha podido guardar el tema/)
    expect(t.applied).toEqual(["rosa", "light"])
    expect(t.current).toBe("light")
  })
  it("a thrown action (server down) also reverts", async () => {
    const t = deps("dark", async () => { throw new Error("fetch failed") })
    const r = await changeAccountTheme("system", t.d)
    expect(r.ok).toBe(false)
    expect(t.current).toBe("dark")
  })
  it("a failure does not undo a later change made meanwhile", async () => {
    let rejectFirst: (r: ActionResult<unknown>) => void = () => {}
    const t = deps("dark", () => new Promise((r) => { rejectFirst = r }))
    const first = changeAccountTheme("rosa", t.d)
    t.d.apply("light") // another change (this tab or an account.prefs.changed event) before the first answer
    rejectFirst(failed)
    expect((await first).ok).toBe(false)
    expect(t.current).toBe("light")
  })
})
