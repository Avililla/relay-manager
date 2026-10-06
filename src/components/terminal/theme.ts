// xterm palettes (§8.2): hex only. Consoles stay dark: one graphite palette for Oscuro and Claro, and a dark-grape
// candy one for Rosa (every ANSI colour except black ≥ 4.5:1 on its background; see theme.test.ts).
// globals.css mirrors each background/foreground as --xterm-bg / --xterm-fg so the hosts paint the same colour
// before xterm opens (no seam, no flash); the contrast test checks they agree.
import type { ITheme } from "@xterm/xterm"
import type { ResolvedTheme } from "@/lib/client/theme"

export const TERMINAL_THEME: ITheme = {
  background: "#060809",
  foreground: "#dbdee1",
  cursor: "#63aaec",
  cursorAccent: "#060809",
  selectionBackground: "#63aaec59",
  black: "#2a2e31",
  red: "#f66d67",
  green: "#61cb7c",
  yellow: "#ebbd57",
  blue: "#67aaed",
  magenta: "#d285cb",
  cyan: "#5dcbd1",
  white: "#d5d8da",
  brightBlack: "#393e41",
  brightRed: "#ff8079",
  brightGreen: "#75df8f",
  brightYellow: "#ffd16b",
  brightBlue: "#7abdff",
  brightMagenta: "#e698df",
  brightCyan: "#72dee4",
  brightWhite: "#e8ecee",
}

/**
 * Rosa: a very dark grape background with white text and a candy ANSI set (cherry, lime gummy, lemon, blue raspberry,
 * bubblegum, mint); bubblegum cursor. Red stays a clear cherry red for errors.
 */
export const ROSA_TERMINAL_THEME: ITheme = {
  background: "#1a0a1e",
  foreground: "#fff4fa",
  cursor: "#ff7ad9",
  cursorAccent: "#1a0a1e",
  selectionBackground: "#ff7ad966",
  black: "#3d2342",
  red: "#ff5e78",
  green: "#7cf29a",
  yellow: "#ffe45c",
  blue: "#6cc8ff",
  magenta: "#ff7ad9",
  cyan: "#5cefe0",
  white: "#f3dcef",
  brightBlack: "#9d7ca3",
  brightRed: "#ff8a9d",
  brightGreen: "#a6ffbd",
  brightYellow: "#fff08c",
  brightBlue: "#9ddcff",
  brightMagenta: "#ffa8ea",
  brightCyan: "#9dfff2",
  brightWhite: "#ffffff",
}

/** The xterm palette for a resolved theme. */
export function terminalThemeFor(theme: ResolvedTheme): ITheme {
  return theme === "rosa" ? ROSA_TERMINAL_THEME : TERMINAL_THEME
}

export const TERMINAL_BG = TERMINAL_THEME.background as string

/** First family of the self-hosted mono font variable (set by next/font on <html>), or null before it exists. */
export function monoFamily(): string | null {
  if (typeof document === "undefined") return null
  const v = getComputedStyle(document.documentElement).getPropertyValue("--font-mono-family").trim()
  const first = v.split(",")[0]?.trim()
  return first ? first : null
}

/** `"<Atkinson Mono family>", "DejaVu Sans Mono", monospace` (§8.10). */
export function terminalFontFamily(): string {
  const first = monoFamily()
  return [first, "\"DejaVu Sans Mono\"", "monospace"].filter(Boolean).join(", ")
}
