"use client"

import { useCallback, useSyncExternalStore } from "react"
import { toast } from "sonner"
import { setMyTheme } from "@/actions/account"
import { THEME_KEY, applyThemePref, parseThemePref, type ResolvedTheme, type ThemePref } from "@/lib/client/theme"
import { cacheAccountTheme, changeAccountTheme } from "@/lib/client/theme-account"
import { readPref } from "@/lib/client/prefs"

function subscribeAttr(name: string): (onChange: () => void) => () => void {
  return (onChange) => {
    const mo = new MutationObserver(onChange)
    mo.observe(document.documentElement, { attributes: true, attributeFilter: [name] })
    return () => mo.disconnect()
  }
}
const subscribeThemeAttr = subscribeAttr("data-theme")
const subscribePrefAttr = subscribeAttr("data-theme-pref")

/** The theme applied to <html> right now (client only). */
export const resolvedSnapshot = (): ResolvedTheme => {
  const t = document.documentElement.getAttribute("data-theme")
  return t === "light" || t === "rosa" ? t : "dark"
}

/** The preference applied to <html> right now (`data-theme-pref`, set by the inline script and applyThemePref). */
export const prefSnapshot = (): ThemePref => parseThemePref(document.documentElement.getAttribute("data-theme-pref"))

/** The theme currently applied to <html> ("dark" on the server: the no-JS fallback). */
export function useResolvedTheme(): ResolvedTheme {
  return useSyncExternalStore(subscribeThemeAttr, resolvedSnapshot, () => "dark")
}

/** Applies a preference to this page and to this browser's cache (read by the login page and the other tabs). */
export function applyAccountTheme(p: ThemePref): void {
  applyThemePref(p)
  cacheAccountTheme(p)
}

/**
 * The account's theme ("dark" | "light" | "rosa" | "system", D39) and a setter that applies it at once and saves it
 * in the account (setMyTheme). On failure the previous theme comes back with a toast. The value is the one on <html>,
 * so other tabs (the `storage` event) and PCs (`account.prefs.changed`) show up here too.
 */
export function useThemePreference(): [ThemePref, (p: ThemePref) => void] {
  const pref = useSyncExternalStore(subscribePrefAttr, prefSnapshot, () => "dark" as const)
  const set = useCallback((p: ThemePref) => {
    void changeAccountTheme(p, { current: prefSnapshot, apply: applyAccountTheme, save: (theme) => setMyTheme({ theme }) }).then((r) => {
      if (!r.ok) toast.error(r.message)
    })
  }, [])
  return [pref, set]
}

/** Re-applies the cached preference when another tab of this browser changes it. Mounted once by AppProviders. */
export function syncThemeFromStorage(e: StorageEvent): void {
  if (e.key === THEME_KEY) applyThemePref(parseThemePref(e.newValue ?? readPref(THEME_KEY)))
}
