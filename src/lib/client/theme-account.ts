// The account theme on the client (D39): the localStorage cache, the first-login adoption of a legacy browser choice
// and the optimistic change. The server action is injected (`save`), so this module stays pure and testable.
import type { ActionResult } from "@/lib/contracts/common"
import { shell } from "@/lib/i18n/shell"
import { browserStorage, readRaw, writePref, type PrefStorage } from "./prefs"
import { THEME_ACCOUNT_KEY, THEME_KEY, applyThemePref, pickThemePref, themeToAdopt, type ThemePref } from "./theme"

type Save = (p: ThemePref) => Promise<ActionResult<unknown>>

/** Stores the account's theme as this browser's cache (read by the login page), marked as the account's. Never throws. */
export function cacheAccountTheme(p: ThemePref, storage: PrefStorage | null = browserStorage()): void {
  writePref(THEME_KEY, p, storage)
  try {
    storage?.setItem(THEME_ACCOUNT_KEY, "1")
  } catch {
    // Blocked storage: the account still has the theme; only the login page falls back to dark.
  }
}

export function readStoredTheme(storage: PrefStorage | null = browserStorage()): { stored: string | null; marked: boolean } {
  return { stored: readRaw(THEME_KEY, storage), marked: readRaw(THEME_ACCOUNT_KEY, storage) === "1" }
}

/**
 * Applies the precedence of the inline script again (client only): the root layout's `data-theme-user` may have been
 * re-rendered by a refresh, and React then patches `data-theme` with the server's placeholder (dark for "system").
 */
export function applyThemeDecision(account: string | null, storage: PrefStorage | null = browserStorage()): ThemePref {
  const { stored, marked } = readStoredTheme(storage)
  const d = pickThemePref(account, stored, marked)
  if (d.cache) cacheAccountTheme(d.pref, storage)
  applyThemePref(d.pref)
  return d.pref
}

/**
 * First login after the upgrade: an account without a theme adopts this browser's legacy choice (a value not marked as
 * an account's), once. A failed save leaves it unmarked, so the next page load tries again. Returns what was adopted.
 */
export async function adoptStoredTheme(account: ThemePref | null, deps: { storage: PrefStorage | null; save: Save }): Promise<ThemePref | null> {
  const { stored, marked } = readStoredTheme(deps.storage)
  const p = themeToAdopt(account, stored, marked)
  if (!p) return null
  try {
    const r = await deps.save(p)
    if (!r.ok) return null
  } catch {
    return null
  }
  try {
    deps.storage?.setItem(THEME_ACCOUNT_KEY, "1")
  } catch {
    // Blocked storage: nothing to mark.
  }
  return p
}

export interface ChangeThemeDeps {
  /** The preference applied right now (`data-theme-pref`). */
  current(): ThemePref
  /** Applies a preference to the page and the cache. */
  apply(p: ThemePref): void
  save: Save
}

/**
 * Optimistic change: applied at once, then saved in the account. On failure the previous theme comes back, unless
 * another change (this tab or an `account.prefs.changed` event) happened meanwhile, and a Spanish message is returned.
 */
export async function changeAccountTheme(next: ThemePref, deps: ChangeThemeDeps): Promise<{ ok: true } | { ok: false; message: string }> {
  const prev = deps.current()
  if (prev === next) return { ok: true }
  deps.apply(next)
  let saved = false
  try {
    saved = (await deps.save(next)).ok
  } catch {
    saved = false
  }
  if (saved) return { ok: true }
  if (deps.current() === next) deps.apply(prev)
  return { ok: false, message: shell.themeSaveFailed }
}
