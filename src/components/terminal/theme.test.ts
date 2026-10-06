import { readFileSync } from "node:fs"
import path from "node:path"
import type { ITheme } from "@xterm/xterm"
import { describe, expect, it } from "vitest"
import { contrastRatio, extractThemeTokens, type Rgba } from "@/lib/client/contrast"
import { ROSA_TERMINAL_THEME, TERMINAL_THEME, terminalThemeFor } from "./theme"

const css = readFileSync(path.resolve(__dirname, "../../app/globals.css"), "utf8")
const themes = extractThemeTokens(css)

function hex(v: string | undefined): Rgba {
  const m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(v ?? "")
  if (!m) throw new Error(`Not a #rrggbb colour: ${v}`)
  const n = parseInt(m[1], 16)
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255, a: 1 }
}

const ANSI = ["red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite"] as const

describe("terminal palettes", () => {
  it("Rosa gets the grape candy palette; Oscuro and Claro keep the graphite one", () => {
    expect(terminalThemeFor("rosa")).toBe(ROSA_TERMINAL_THEME)
    expect(terminalThemeFor("dark")).toBe(TERMINAL_THEME)
    expect(terminalThemeFor("light")).toBe(TERMINAL_THEME)
  })

  it("globals.css --xterm-bg / --xterm-fg mirror the palettes (hosts paint the same colour as xterm)", () => {
    expect(themes.dark["xterm-bg"]).toBe(TERMINAL_THEME.background)
    expect(themes.dark["xterm-fg"]).toBe(TERMINAL_THEME.foreground)
    expect(themes.light["xterm-bg"], "Claro inherits the dark console colours").toBeUndefined()
    expect(themes.rosa["xterm-bg"]).toBe(ROSA_TERMINAL_THEME.background)
    expect(themes.rosa["xterm-fg"]).toBe(ROSA_TERMINAL_THEME.foreground)
  })

  describe("Rosa palette legibility", () => {
    const p: ITheme = ROSA_TERMINAL_THEME
    const bg = hex(p.background)
    it("stays dark (consoles never turn light)", () => {
      expect(contrastRatio(bg, { r: 0, g: 0, b: 0, a: 1 })).toBeLessThan(1.3)
    })
    it("foreground ≥ 7:1 and every ANSI colour except black ≥ 4.5:1 on the background", () => {
      expect(contrastRatio(hex(p.foreground), bg)).toBeGreaterThanOrEqual(7)
      for (const k of ANSI) expect(contrastRatio(hex(p[k]), bg), k).toBeGreaterThanOrEqual(4.5)
    })
    it("bright black (dim text) ≥ 3:1 and the cursor ≥ 3:1", () => {
      expect(contrastRatio(hex(p.brightBlack), bg)).toBeGreaterThanOrEqual(3)
      expect(contrastRatio(hex(p.cursor), bg)).toBeGreaterThanOrEqual(3)
    })
    it("the cursor accent (text under the block cursor) ≥ 4.5:1 on the cursor", () => {
      expect(contrastRatio(hex(p.cursorAccent), hex(p.cursor))).toBeGreaterThanOrEqual(4.5)
    })
  })
})
