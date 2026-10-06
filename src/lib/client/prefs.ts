// Per-browser preferences (§8.8). These are the ONLY localStorage keys the app uses:
//   rm-theme, rm-theme-account, rm-term-font, rm-term-scrollback, rm-term-sr, rm-layout:<equipmentId>,
//   rm-panes:<equipmentId>:<layout>:<N>, rm-banco-view, rm-files-archive:<userId>
// The theme belongs to the user's account (D39): rm-theme is only the cache for the pages without a session, and
// rm-theme-account marks it as copied from an account (theme.ts, theme-account.ts).
// Every access is wrapped in try/catch (private mode, blocked storage, plain HTTP quirks).
import { parseThemePref, type ThemePref } from "./theme"

export const TERM_FONT = { min: 11, max: 16, default: 13 } as const
export const TERM_SCROLLBACK = { min: 1000, max: 50000, default: 10000 } as const
export const WORKSPACE_LAYOUTS = ["columns", "grid", "tabs"] as const
export type WorkspaceLayout = (typeof WORKSPACE_LAYOUTS)[number]
export type BancoView = "grid" | "list"
/** Archivos: the archive format last chosen for folder downloads. */
export type ArchiveFormatPref = "zip" | "tar.gz"

type IdKey = `${string}`
export type PrefKey =
  | "rm-theme" | "rm-term-font" | "rm-term-scrollback" | "rm-term-sr" | "rm-banco-view"
  | `rm-layout:${IdKey}` | `rm-panes:${IdKey}:${WorkspaceLayout}:${number}` | `rm-files-archive:${IdKey}`

export type PrefValue<K extends PrefKey> =
  K extends "rm-theme" ? ThemePref :
  K extends "rm-term-font" | "rm-term-scrollback" ? number :
  K extends "rm-term-sr" ? boolean :
  K extends "rm-banco-view" ? BancoView :
  K extends `rm-layout:${string}` ? WorkspaceLayout | null :
  K extends `rm-panes:${string}` ? string | null :
  K extends `rm-files-archive:${string}` ? ArchiveFormatPref | null :
  never

export type ParsedPrefKey =
  | { kind: "theme" } | { kind: "term-font" } | { kind: "term-scrollback" } | { kind: "term-sr" } | { kind: "banco-view" }
  | { kind: "layout"; equipmentId: string }
  | { kind: "panes"; equipmentId: string; layout: WorkspaceLayout; count: number }
  | { kind: "files-archive"; userId: string }

const ID = /^[A-Za-z0-9]{1,64}$/

export function parsePrefKey(key: string): ParsedPrefKey | null {
  switch (key) {
    case "rm-theme": return { kind: "theme" }
    case "rm-term-font": return { kind: "term-font" }
    case "rm-term-scrollback": return { kind: "term-scrollback" }
    case "rm-term-sr": return { kind: "term-sr" }
    case "rm-banco-view": return { kind: "banco-view" }
  }
  const parts = key.split(":")
  if (parts[0] === "rm-layout" && parts.length === 2 && ID.test(parts[1])) return { kind: "layout", equipmentId: parts[1] }
  if (parts[0] === "rm-files-archive" && parts.length === 2 && ID.test(parts[1])) return { kind: "files-archive", userId: parts[1] }
  if (parts[0] === "rm-panes" && parts.length === 4 && ID.test(parts[1]) && (WORKSPACE_LAYOUTS as readonly string[]).includes(parts[2])
    && /^\d{1,2}$/.test(parts[3])) {
    const count = Number(parts[3])
    if (count >= 1 && count <= 16) return { kind: "panes", equipmentId: parts[1], layout: parts[2] as WorkspaceLayout, count }
  }
  return null
}

export const layoutKey = (equipmentId: string): `rm-layout:${string}` => `rm-layout:${equipmentId}`
export const archiveFormatKey = (userId: string): `rm-files-archive:${string}` => `rm-files-archive:${userId}`
export const panesKey = (equipmentId: string, layout: WorkspaceLayout, count: number): `rm-panes:${string}:${WorkspaceLayout}:${number}` =>
  `rm-panes:${equipmentId}:${layout}:${count}`

function intInRange(raw: string | null, r: { min: number; max: number; default: number }): number {
  if (raw === null || raw.trim() === "") return r.default
  const n = Number(raw)
  if (!Number.isFinite(n)) return r.default
  return Math.min(r.max, Math.max(r.min, Math.trunc(n)))
}

export function parsePref<K extends PrefKey>(key: K, raw: string | null): PrefValue<K> {
  const k = parsePrefKey(key)
  let v: unknown = null
  switch (k?.kind) {
    case "theme": v = parseThemePref(raw); break
    case "term-font": v = intInRange(raw, TERM_FONT); break
    case "term-scrollback": v = intInRange(raw, TERM_SCROLLBACK); break
    case "term-sr": v = raw === "1"; break
    case "banco-view": v = raw === "list" ? "list" : "grid"; break
    case "layout": v = raw !== null && (WORKSPACE_LAYOUTS as readonly string[]).includes(raw) ? raw : null; break
    case "panes": v = raw; break
    case "files-archive": v = raw === "zip" || raw === "tar.gz" ? raw : null; break
  }
  return v as PrefValue<K>
}

export function serializePref<K extends PrefKey>(key: K, value: PrefValue<K>): string {
  const k = parsePrefKey(key)
  switch (k?.kind) {
    case "term-font": return String(intInRange(String(Math.round(value as number)), TERM_FONT))
    case "term-scrollback": return String(intInRange(String(Math.round(value as number)), TERM_SCROLLBACK))
    case "term-sr": return value ? "1" : "0"
    default: return value === null || value === undefined ? "" : String(value)
  }
}

export interface PrefStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export function browserStorage(): PrefStorage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null
  } catch {
    return null
  }
}

export function readRaw(key: string, storage: PrefStorage | null = browserStorage()): string | null {
  try {
    return storage?.getItem(key) ?? null
  } catch {
    return null
  }
}

export function readPref<K extends PrefKey>(key: K, storage: PrefStorage | null = browserStorage()): PrefValue<K> {
  return parsePref(key, readRaw(key, storage))
}

/** Event name used to sync preferences between hooks in the same tab (the `storage` event covers other tabs). */
export const PREF_EVENT = "rm-pref-change"

export function writePref<K extends PrefKey>(key: K, value: PrefValue<K>, storage: PrefStorage | null = browserStorage()): boolean {
  try {
    if (!storage) return false
    if (value === null) storage.removeItem(key)
    else storage.setItem(key, serializePref(key, value))
    if (typeof window !== "undefined" && typeof CustomEvent === "function") {
      window.dispatchEvent(new CustomEvent(PREF_EVENT, { detail: { key } }))
    }
    return true
  } catch {
    return false
  }
}

/** react-resizable-panels stores `autoSaveId` under this prefix; `panesStorage` strips it (§8.9). */
export const PANES_STORAGE_PREFIX = "react-resizable-panels:"

/**
 * A PanelGroup `storage` that keeps the layout under `rm-panes:<id>:<layout>:<N>` and never throws.
 *
 * Every `PanelGroup`, `Panel` and `PanelResizeHandle` MUST get an explicit, stable `id` (the group: its `autoSaveId`,
 * e.g. `panesKey(...)`; a panel: its consoleId; a handle: `<groupId>:handle:<n>`). Without one the library takes
 * the id from `useId`, and the intermittent hydration id mismatch seen under Next 16 / React 19.2 then crashes the
 * group with 'No group found for id "…"' (the server's `data-panel-group-id` stays in the DOM).
 */
export function panesStorage(storage: PrefStorage | null = browserStorage()): { getItem(name: string): string | null; setItem(name: string, value: string): void } {
  const map = (name: string): string | null => {
    const key = name.startsWith(PANES_STORAGE_PREFIX) ? name.slice(PANES_STORAGE_PREFIX.length) : name
    return parsePrefKey(key)?.kind === "panes" ? key : null
  }
  return {
    getItem(name) {
      const key = map(name)
      return key ? readRaw(key, storage) : null
    },
    setItem(name, value) {
      const key = map(name)
      if (!key) return
      try {
        storage?.setItem(key, value)
      } catch {
        // Quota or blocked storage: the layout simply is not remembered.
      }
    },
  }
}
