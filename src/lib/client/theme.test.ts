import { afterEach, describe, expect, it, vi } from "vitest"
import {
  THEME_ACCOUNT_KEY, THEME_KEY, THEME_PREFS, THEME_USER_ATTR, applyThemePref, colorSchemeOf, htmlThemeAttrs, parseThemePref, pickThemePref,
  resolveTheme, themeScript, themeToAdopt,
} from "./theme"

describe("theme preference", () => {
  it("missing or invalid values mean dark (D39)", () => {
    expect(parseThemePref(null)).toBe("dark")
    expect(parseThemePref(undefined)).toBe("dark")
    expect(parseThemePref("")).toBe("dark")
    expect(parseThemePref("blue")).toBe("dark")
    expect(parseThemePref("DARK")).toBe("dark")
    expect(parseThemePref("light")).toBe("light")
    expect(parseThemePref("system")).toBe("system")
    expect(parseThemePref("dark")).toBe("dark")
    expect(parseThemePref("rosa")).toBe("rosa")
    expect(parseThemePref("Rosa")).toBe("dark")
  })

  it("offers the four choices in menu order", () => {
    expect(THEME_PREFS).toEqual(["dark", "light", "rosa", "system"])
  })

  it("rosa is explicit: system never resolves to it, and it is a dark color-scheme (white text on pink)", () => {
    expect(resolveTheme("rosa", true)).toBe("rosa")
    expect(resolveTheme("rosa", false)).toBe("rosa")
    expect(colorSchemeOf("rosa")).toBe("dark")
    expect(colorSchemeOf("light")).toBe("light")
    expect(colorSchemeOf("dark")).toBe("dark")
  })

  it("system follows prefers-color-scheme", () => {
    expect(resolveTheme("system", true)).toBe("dark")
    expect(resolveTheme("system", false)).toBe("light")
    expect(resolveTheme("dark", false)).toBe("dark")
    expect(resolveTheme("light", true)).toBe("light")
  })
})

/** Runs the inline no-flash script against fakes (it only touches these globals). */
function runScript(stored: string | null | "throw", prefersDark: boolean, opts: { account?: string | null; marked?: boolean } = {}) {
  const attrs: Record<string, string> = {}
  if (opts.account !== undefined && opts.account !== null) attrs[THEME_USER_ATTR] = opts.account
  const writes: Record<string, string> = {}
  const listeners: Array<(e: { matches: boolean }) => void> = []
  const mql = {
    matches: prefersDark,
    addEventListener: (_: string, fn: (e: { matches: boolean }) => void) => { listeners.push(fn) },
  }
  const window = {
    localStorage: {
      getItem: (k: string) => {
        if (stored === "throw") throw new Error("SecurityError")
        if (k === THEME_ACCOUNT_KEY) return opts.marked ? "1" : null
        return k === THEME_KEY ? stored : null
      },
      setItem: (k: string, v: string) => {
        if (stored === "throw") throw new Error("SecurityError")
        writes[k] = v
      },
    },
    matchMedia: (q: string) => {
      expect(q).toBe("(prefers-color-scheme: dark)")
      return mql
    },
  }
  const document = {
    documentElement: {
      setAttribute: (k: string, v: string) => { attrs[k] = v },
      getAttribute: (k: string) => attrs[k] ?? null,
      style: { colorScheme: "" },
    },
  }
  new Function("window", "document", "localStorage", themeScript())(window, document, window.localStorage)
  return { attrs, listeners, document, writes }
}

describe("no-flash theme script", () => {
  it("applies dark when storage is empty", () => {
    expect(runScript(null, false).attrs["data-theme"]).toBe("dark")
  })
  it("applies dark for an invalid value and when storage throws", () => {
    expect(runScript("sepia", false).attrs["data-theme"]).toBe("dark")
    expect(runScript("throw", false).attrs["data-theme"]).toBe("dark")
  })
  it("applies light, and an OS change does not override it", () => {
    const r = runScript("light", true)
    expect(r.attrs["data-theme"]).toBe("light")
    expect(r.attrs["data-theme-pref"]).toBe("light")
    r.listeners.forEach((fn) => fn({ matches: true }))
    expect(r.attrs["data-theme"]).toBe("light")
  })
  it("applies rosa before paint with a dark color-scheme, and an OS change does not override it", () => {
    const r = runScript("rosa", true)
    expect(r.attrs["data-theme"]).toBe("rosa")
    expect(r.attrs["data-theme-pref"]).toBe("rosa")
    expect(r.document.documentElement.style.colorScheme).toBe("dark")
    r.listeners.forEach((fn) => fn({ matches: false }))
    r.listeners.forEach((fn) => fn({ matches: true }))
    expect(r.attrs["data-theme"]).toBe("rosa")
  })
  it("sets color-scheme dark and light for the other themes", () => {
    expect(runScript("dark", false).document.documentElement.style.colorScheme).toBe("dark")
    expect(runScript("light", true).document.documentElement.style.colorScheme).toBe("light")
  })
  it("system without matchMedia falls back to dark", () => {
    const attrs: Record<string, string> = {}
    const document = { documentElement: { setAttribute: (k: string, v: string) => { attrs[k] = v }, getAttribute: (k: string) => attrs[k] ?? null, style: { colorScheme: "" } } }
    const window = { localStorage: { getItem: () => "system" } }
    new Function("window", "document", themeScript())(window, document)
    expect(attrs["data-theme"]).toBe("dark")
    expect(attrs["data-theme-pref"]).toBe("system")
  })
  it("system follows matchMedia and re-applies on change", () => {
    const r = runScript("system", false)
    expect(r.attrs["data-theme"]).toBe("light")
    expect(r.attrs["data-theme-pref"]).toBe("system")
    expect(r.listeners).toHaveLength(1)
    r.listeners[0]({ matches: true })
    expect(r.attrs["data-theme"]).toBe("dark")
  })
  it("a runtime switch to system (applyThemePref) follows later OS changes without a reload", () => {
    // Loaded with the default (dark, nothing stored); the user then picks "Sistema" with the OS on dark.
    const r = runScript(null, true)
    expect(r.attrs["data-theme"]).toBe("dark")
    expect(r.listeners).toHaveLength(1)
    r.document.documentElement.setAttribute("data-theme-pref", "system")
    r.listeners[0]({ matches: false })
    expect(r.attrs["data-theme"]).toBe("light")
    r.listeners[0]({ matches: true })
    expect(r.attrs["data-theme"]).toBe("dark")
  })
  it("the change listener stops applying once the preference is no longer system", () => {
    const r = runScript("system", true)
    r.document.documentElement.setAttribute("data-theme-pref", "light")
    r.document.documentElement.setAttribute("data-theme", "light")
    r.listeners[0]({ matches: true })
    expect(r.attrs["data-theme"]).toBe("light")
  })
})

describe("applyThemePref (runtime switch) agrees with the inline script", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })
  function stub(matchMedia: ((q: string) => { matches: boolean }) | undefined) {
    const attrs: Record<string, string> = {}
    const style = { colorScheme: "" }
    vi.stubGlobal("window", matchMedia ? { matchMedia } : {})
    vi.stubGlobal("document", { documentElement: { setAttribute: (k: string, v: string) => { attrs[k] = v }, style } })
    return { attrs, style }
  }
  it("system without matchMedia resolves to dark, like the script", () => {
    const r = stub(undefined)
    expect(applyThemePref("system")).toBe("dark")
    expect(r.attrs).toEqual({ "data-theme-pref": "system", "data-theme": "dark" })
    expect(r.style.colorScheme).toBe("dark")
  })
  it("system follows matchMedia; dark and light ignore it", () => {
    stub(() => ({ matches: false }))
    expect(applyThemePref("system")).toBe("light")
    expect(applyThemePref("dark")).toBe("dark")
    stub(() => ({ matches: true }))
    expect(applyThemePref("system")).toBe("dark")
    expect(applyThemePref("light")).toBe("light")
  })
  it("rosa sets data-theme=rosa with a dark color-scheme, whatever the OS says", () => {
    const r = stub(() => ({ matches: true }))
    expect(applyThemePref("rosa")).toBe("rosa")
    expect(r.attrs).toEqual({ "data-theme-pref": "rosa", "data-theme": "rosa" })
    expect(r.style.colorScheme).toBe("dark")
  })
})

describe("account theme precedence (the theme is saved per user, D39)", () => {
  it("signed in with a theme in the account: it wins over localStorage and is cached (marked as the account's)", () => {
    expect(pickThemePref("rosa", "light", false)).toEqual({ pref: "rosa", cache: true })
    expect(pickThemePref("rosa", "light", true)).toEqual({ pref: "rosa", cache: true })
    expect(pickThemePref("system", null, false)).toEqual({ pref: "system", cache: true })
    expect(pickThemePref("dark", "rosa", false)).toEqual({ pref: "dark", cache: true })
  })
  it("signed in without a theme: a legacy per-browser choice is shown (and adopted), never another account's cached one", () => {
    expect(pickThemePref("", "light", false)).toEqual({ pref: "light", cache: false })
    expect(pickThemePref("", "rosa", true)).toEqual({ pref: "dark", cache: true })
    expect(pickThemePref("", null, false)).toEqual({ pref: "dark", cache: true })
    expect(pickThemePref("", "sepia", false)).toEqual({ pref: "dark", cache: true })
    // An unknown value from the server counts as "no theme chosen".
    expect(pickThemePref("sepia", "light", false)).toEqual({ pref: "light", cache: false })
  })
  it("signed out (login, setup): the cached theme of the last user of this browser, otherwise dark; nothing is written", () => {
    expect(pickThemePref(null, "rosa", true)).toEqual({ pref: "rosa", cache: false })
    expect(pickThemePref(null, "light", false)).toEqual({ pref: "light", cache: false })
    expect(pickThemePref(null, null, false)).toEqual({ pref: "dark", cache: false })
    expect(pickThemePref(null, "sepia", false)).toEqual({ pref: "dark", cache: false })
  })
  it("adoption on first login: only an account without a theme adopts a legacy (unmarked) browser choice", () => {
    expect(themeToAdopt(null, "rosa", false)).toBe("rosa")
    expect(themeToAdopt(null, "system", false)).toBe("system")
    expect(themeToAdopt(null, "rosa", true)).toBeNull()
    expect(themeToAdopt("light", "rosa", false)).toBeNull()
    expect(themeToAdopt(null, null, false)).toBeNull()
    expect(themeToAdopt(null, "sepia", false)).toBeNull()
  })
})

describe("htmlThemeAttrs (root layout: <html> rendered from the viewer's account)", () => {
  it("signed out: dark, no account attribute and no inline color-scheme (the script reads the cache)", () => {
    expect(htmlThemeAttrs(null)).toEqual({ theme: "dark", user: undefined, colorScheme: undefined })
  })
  it("an explicit theme is rendered as is, with its color-scheme", () => {
    expect(htmlThemeAttrs({ theme: "rosa" })).toEqual({ theme: "rosa", user: "rosa", colorScheme: "dark" })
    expect(htmlThemeAttrs({ theme: "light" })).toEqual({ theme: "light", user: "light", colorScheme: "light" })
    expect(htmlThemeAttrs({ theme: "dark" })).toEqual({ theme: "dark", user: "dark", colorScheme: "dark" })
  })
  it("system: dark until the script resolves prefers-color-scheme before paint", () => {
    expect(htmlThemeAttrs({ theme: "system" })).toEqual({ theme: "dark", user: "system", colorScheme: "dark" })
  })
  it("signed in without a theme: dark and an empty account attribute", () => {
    expect(htmlThemeAttrs({ theme: null })).toEqual({ theme: "dark", user: "", colorScheme: "dark" })
  })
})

describe("no-flash script with a signed-in viewer (data-theme-user)", () => {
  it("the account's theme wins over localStorage and refreshes the cache for the login page", () => {
    const r = runScript("light", true, { account: "rosa" })
    expect(r.attrs["data-theme"]).toBe("rosa")
    expect(r.attrs["data-theme-pref"]).toBe("rosa")
    expect(r.document.documentElement.style.colorScheme).toBe("dark")
    expect(r.writes).toEqual({ [THEME_KEY]: "rosa", [THEME_ACCOUNT_KEY]: "1" })
  })
  it("account system: resolves prefers-color-scheme and follows it", () => {
    const r = runScript("rosa", false, { account: "system" })
    expect(r.attrs["data-theme"]).toBe("light")
    expect(r.attrs["data-theme-pref"]).toBe("system")
    r.listeners[0]({ matches: true })
    expect(r.attrs["data-theme"]).toBe("dark")
  })
  it("signed out: nothing is written", () => {
    expect(runScript("rosa", false).writes).toEqual({})
  })
  it("blocked storage still applies the account's theme", () => {
    expect(runScript("throw", false, { account: "rosa" }).attrs["data-theme"]).toBe("rosa")
  })
  it("agrees with pickThemePref for every combination", () => {
    const accounts = [null, "", "dark", "light", "rosa", "system", "sepia"]
    const stored = [null, "dark", "light", "rosa", "system", "sepia"]
    for (const account of accounts) {
      for (const s of stored) {
        for (const marked of [false, true]) {
          const want = pickThemePref(account, s, marked)
          const r = runScript(s, true, { account, marked })
          const where = JSON.stringify({ account, s, marked })
          expect(r.attrs["data-theme-pref"], where).toBe(want.pref)
          expect(r.attrs["data-theme"], where).toBe(resolveTheme(want.pref, true))
          expect(r.writes, where).toEqual(want.cache ? { [THEME_KEY]: want.pref, [THEME_ACCOUNT_KEY]: "1" } : {})
        }
      }
    }
  })
})
