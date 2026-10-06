// Workspace pure logic (§8.9): console layouts, grid shape and the document-level keyboard shortcuts.
import type { WorkspaceLayout } from "@/lib/client/prefs"

/** "Columnas" for up to 3 consoles, "Cuadrícula" from 4. */
export function defaultLayout(consoleCount: number): WorkspaceLayout {
  return consoleCount >= 4 ? "grid" : "columns"
}

/** The stored preference (or the default); tabs are forced below 768 px. */
export function effectiveLayout(pref: WorkspaceLayout | null, consoleCount: number, narrow: boolean): WorkspaceLayout {
  if (narrow) return "tabs"
  return pref ?? defaultLayout(consoleCount)
}

/** 2 columns; 3 when there are 7 or more consoles and the viewport is at least 1600 px wide. */
export function gridColumns(consoleCount: number, viewportWidth: number): number {
  if (consoleCount <= 1) return 1
  return consoleCount >= 7 && viewportWidth >= 1600 ? 3 : 2
}

export function gridRows<T>(items: readonly T[], cols: number): T[][] {
  const rows: T[][] = []
  for (let i = 0; i < items.length; i += cols) rows.push(items.slice(i, i + cols))
  return rows
}

export type WorkspaceShortcut = { kind: "focus"; index: number } | { kind: "toggle-maximize" } | { kind: "restore" } | null

interface KeyLike { key: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }

/**
 * Ctrl+Alt+1..9 focuses pane N, Ctrl+Alt+Enter maximises or restores, Esc restores a maximised pane when the focus
 * is outside the terminal (§8.9). The terminal returns `false` for these chords, so nothing reaches the port.
 * Matching on `key` (not `code`) keeps AltGr symbols such as "|" (AltGr+1 on Spanish keyboards) out of it.
 */
export function parseShortcut(e: KeyLike, ctx: { maximized: boolean; inTerminal: boolean }): WorkspaceShortcut {
  if (e.metaKey) return null
  if (e.ctrlKey && e.altKey && !e.shiftKey) {
    if (/^[1-9]$/.test(e.key)) return { kind: "focus", index: Number(e.key) - 1 }
    if (e.key === "Enter") return { kind: "toggle-maximize" }
    return null
  }
  if (e.key === "Escape" && !e.ctrlKey && !e.altKey && !e.shiftKey && ctx.maximized && !ctx.inTerminal) return { kind: "restore" }
  return null
}

export function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i])
}
