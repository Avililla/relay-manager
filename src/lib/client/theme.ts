// Theme resolution (D39, §8.2): dark by default; "light", "rosa" and "system" are opt-in. "Rosa" is a dark-scheme
// bubblegum theme (white text on saturated pink) with its own terminal palette; "system" only ever resolves to dark or light.
//
// The theme is saved in the user's account (User.theme) and the root layout renders it on <html>, so a signed-in page
// never flashes another theme. localStorage (THEME_KEY) is only a cache for the pages without a session (login,
// setup): it holds the theme of the last user of this browser. Precedence: pickThemePref.
import { THEME_PREFS, type ThemePref } from "@/lib/contracts/enums"

export { THEME_PREFS, type ThemePref }
export const THEME_KEY = "rm-theme"
/** "1" when THEME_KEY was copied from a signed-in account; a value without it is a legacy per-browser choice (≤ 2.2.0). */
export const THEME_ACCOUNT_KEY = "rm-theme-account"
/** On <html>, set by the root layout for a signed-in viewer: the account's theme, or "" when none was chosen. Absent when signed out. */
export const THEME_USER_ATTR = "data-theme-user"
export type ResolvedTheme = "dark" | "light" | "rosa"

/** A missing or invalid stored value means dark. */
export function parseThemePref(v: unknown): ThemePref {
  return isThemePref(v) ? v : "dark"
}

function isThemePref(v: unknown): v is ThemePref {
  return typeof v === "string" && (THEME_PREFS as readonly string[]).includes(v)
}

/** What the page applies, and whether it refreshes the localStorage cache (marked as the account's). */
export interface ThemeDecision { pref: ThemePref; cache: boolean }

/**
 * Precedence (mirrored by the inline script, `themeScript`):
 * 1. signed in with a theme in the account (`account` = that theme): it wins over localStorage and is cached, so the
 *    login page of this browser shows the last user's theme;
 * 2. signed in without one (`account` = "" or unknown): a legacy per-browser choice (stored, not marked) is shown, and
 *    the client adopts it into the account (adoptStoredTheme); never another account's cached theme; else dark, cached;
 * 3. signed out (`account` = null): the cached theme, else dark; nothing is written.
 */
export function pickThemePref(account: string | null, stored: string | null, storedFromAccount: boolean): ThemeDecision {
  if (account === null) return { pref: parseThemePref(stored), cache: false }
  if (isThemePref(account)) return { pref: account, cache: true }
  if (isThemePref(stored) && !storedFromAccount) return { pref: stored, cache: false }
  return { pref: "dark", cache: true }
}

/** First login after the upgrade: the browser's legacy choice to save in an account that has no theme yet, if any. */
export function themeToAdopt(account: ThemePref | null, stored: string | null, storedFromAccount: boolean): ThemePref | null {
  return account === null && !storedFromAccount && isThemePref(stored) ? stored : null
}

/**
 * The <html> attributes the root layout renders (`viewer` null = signed out). "system" renders dark until the inline
 * script resolves prefers-color-scheme, before paint; signed out, the script reads the cache.
 */
export function htmlThemeAttrs(viewer: { theme: ThemePref | null } | null): {
  theme: ResolvedTheme; user: string | undefined; colorScheme: "dark" | "light" | undefined
} {
  if (!viewer) return { theme: "dark", user: undefined, colorScheme: undefined }
  const theme = viewer.theme === null || viewer.theme === "system" ? "dark" : viewer.theme
  return { theme, user: viewer.theme ?? "", colorScheme: colorSchemeOf(theme) }
}

export function resolveTheme(pref: ThemePref, prefersDark: boolean): ResolvedTheme {
  return pref === "system" ? (prefersDark ? "dark" : "light") : pref
}

/** The CSS `color-scheme` of a resolved theme: Rosa is a dark scheme (white text; native controls, scrollbars). */
export function colorSchemeOf(theme: ResolvedTheme): "dark" | "light" {
  return theme === "light" ? "light" : "dark"
}

const MQ = "(prefers-color-scheme: dark)"

/** `prefers-color-scheme: dark`; true without `matchMedia`, so "system" falls back to dark like the inline script. */
export function systemPrefersDark(): boolean {
  return typeof window.matchMedia !== "function" || window.matchMedia(MQ).matches
}

/** Applies a preference to <html> (client only). Keeps `data-theme-pref` for the system listener. */
export function applyThemePref(pref: ThemePref): ResolvedTheme {
  const root = document.documentElement
  const resolved = resolveTheme(pref, systemPrefersDark())
  root.setAttribute("data-theme-pref", pref)
  root.setAttribute("data-theme", resolved)
  root.style.colorScheme = colorSchemeOf(resolved)
  return resolved
}

/**
 * The inline no-flash script (runs in <head> before paint). It only touches `window.localStorage`,
 * `window.matchMedia` and `document.documentElement`; storage access is wrapped in try/catch. It applies
 * `pickThemePref(<data-theme-user>, <THEME_KEY>, <THEME_ACCOUNT_KEY> === "1")`: the signed-in account's theme wins over
 * localStorage, which is only the cache for pages without a session. Its media query `change` listener is registered
 * whatever the preference, and re-applies only while `data-theme-pref` is "system": picking "Sistema" later in the
 * TopBar (applyThemePref) then follows the OS without a reload. Written as ES5 on purpose: it also runs in browsers
 * the app does not support, so the "navegador no compatible" notice can show.
 */
export function themeScript(): string {
  return `(function(){var d=document.documentElement,p="dark",c=false,s=null,f=false,u=d.getAttribute(${JSON.stringify(THEME_USER_ATTR)});
function ok(v){return v==="dark"||v==="light"||v==="rosa"||v==="system"}
try{s=window.localStorage.getItem(${JSON.stringify(THEME_KEY)});f=window.localStorage.getItem(${JSON.stringify(THEME_ACCOUNT_KEY)})==="1"}catch(e){}
if(u===null){if(ok(s))p=s}else if(ok(u)){p=u;c=true}else if(ok(s)&&!f){p=s}else{c=true}
if(c){try{window.localStorage.setItem(${JSON.stringify(THEME_KEY)},p);window.localStorage.setItem(${JSON.stringify(THEME_ACCOUNT_KEY)},"1")}catch(e){}}
function set(t){d.setAttribute("data-theme",t);d.style.colorScheme=t==="light"?"light":"dark"}
d.setAttribute("data-theme-pref",p);
var m=typeof window.matchMedia==="function"?window.matchMedia(${JSON.stringify(MQ)}):null;
set(p==="system"?(m&&!m.matches?"light":"dark"):p==="light"||p==="rosa"?p:"dark");
if(m){var on=function(e){if(d.getAttribute("data-theme-pref")==="system")set(e.matches?"dark":"light")};
if(m.addEventListener)m.addEventListener("change",on);else if(m.addListener)m.addListener(on)}})();`
}

/**
 * Browser support check (D35, §8.12): Tailwind 4 needs oklch(), :where() and @property. On failure it sets
 * `data-unsupported` on <html>, which reveals the static notice rendered by the root layout.
 */
export function browserCheckScript(): string {
  return `(function(){try{var ok=!!(window.CSS&&CSS.supports&&CSS.supports("color","oklch(0.5 0.1 200)")&&CSS.supports("selector(:where(a))")&&("registerProperty" in CSS));if(!ok)document.documentElement.setAttribute("data-unsupported","")}catch(e){document.documentElement.setAttribute("data-unsupported","")}})();`
}
