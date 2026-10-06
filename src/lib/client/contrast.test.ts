import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { THEME_NAMES, composite, contrastRatio, extractThemeTokens, parseOklch, type Rgba } from "./contrast"

const css = readFileSync(path.resolve(__dirname, "../../app/globals.css"), "utf8")
const themes = extractThemeTokens(css)

describe("color math", () => {
  it("converts OKLCH to sRGB", () => {
    const white = parseOklch("oklch(1 0 0)")
    expect(white.r).toBeCloseTo(1, 3)
    expect(white.g).toBeCloseTo(1, 3)
    expect(white.b).toBeCloseTo(1, 3)
    const black = parseOklch("oklch(0 0 0)")
    expect(black.r).toBeCloseTo(0, 5)
    // oklch(0.628 0.2577 29.23) is sRGB red.
    const red = parseOklch("oklch(0.62796 0.25768 29.2339)")
    expect(red.r).toBeCloseTo(1, 2)
    expect(red.g).toBeCloseTo(0, 2)
    expect(red.b).toBeCloseTo(0, 2)
    expect(parseOklch("oklch(0.5 0.1 250 / 0.14)").a).toBeCloseTo(0.14, 5)
  })

  it("computes WCAG contrast ratios", () => {
    const w: Rgba = { r: 1, g: 1, b: 1, a: 1 }
    const k: Rgba = { r: 0, g: 0, b: 0, a: 1 }
    expect(contrastRatio(w, k)).toBeCloseTo(21, 5)
    expect(contrastRatio(w, w)).toBeCloseTo(1, 5)
  })

  it("composites alpha in gamma space", () => {
    const c = composite({ r: 1, g: 0, b: 0, a: 0.5 }, { r: 0, g: 0, b: 1, a: 1 })
    expect(c).toEqual({ r: 0.5, g: 0, b: 0.5, a: 1 })
  })
})

describe("globals.css tokens", () => {
  it("defines every theme with every token", () => {
    const needed = ["background", "card", "popover", "secondary", "accent", "muted", "border", "input", "foreground", "muted-foreground",
      "faint-foreground", "brand", "primary", "primary-foreground", "ring", "ok", "ok-tint", "warn", "warn-tint", "danger", "danger-tint",
      "control-border", "danger-fill", "danger-fill-foreground", "terminal-bg"]
    for (const t of THEME_NAMES) {
      for (const n of needed) expect(themes[t][n], `${t} --${n}`).toBeDefined()
    }
  })

  it("Rosa declares every token Claro declares (nothing silently inherits the dark :root values)", () => {
    for (const n of Object.keys(themes.light)) expect(themes.rosa[n], `rosa --${n}`).toBeDefined()
  })

  for (const theme of THEME_NAMES) {
    describe(`${theme} theme`, () => {
      const tok = (n: string): Rgba => {
        const v = themes[theme][n]
        if (!v) throw new Error(`--${n} missing in ${theme}`)
        return parseOklch(v)
      }
      const surfaces = ["background", "card", "secondary", "muted", "popover"]
      const ratio = (fg: string, bg: string) => contrastRatio(composite(tok(fg), tok(bg)), tok(bg))

      it("body text ≥ 4.5:1 on every surface", () => {
        for (const bg of surfaces) {
          expect(ratio("foreground", bg), `foreground on ${bg}`).toBeGreaterThanOrEqual(4.5)
          expect(ratio("muted-foreground", bg), `muted-foreground on ${bg}`).toBeGreaterThanOrEqual(4.5)
        }
        for (const bg of ["background", "card", "secondary"]) {
          expect(ratio("faint-foreground", bg), `faint-foreground on ${bg}`).toBeGreaterThanOrEqual(4.5)
        }
      })

      it("brand links ≥ 4.5:1 and text on primary ≥ 4.5:1", () => {
        for (const bg of ["background", "card"]) expect(ratio("brand", bg), `brand on ${bg}`).toBeGreaterThanOrEqual(4.5)
        expect(ratio("primary-foreground", "primary")).toBeGreaterThanOrEqual(4.5)
      })

      it("status icons and the focus ring ≥ 3:1 on every surface", () => {
        for (const bg of surfaces) {
          for (const fg of ["ok", "warn", "danger", "ring", "brand"]) {
            expect(ratio(fg, bg), `${fg} on ${bg}`).toBeGreaterThanOrEqual(3)
          }
        }
      })

      it("control boundaries (--control-border) ≥ 3:1 on every surface", () => {
        for (const bg of surfaces) expect(ratio("control-border", bg), `control-border on ${bg}`).toBeGreaterThanOrEqual(3)
      })

      it("--danger-fill-foreground on --danger-fill ≥ 4.5:1", () => {
        expect(ratio("danger-fill-foreground", "danger-fill")).toBeGreaterThanOrEqual(4.5)
      })

      it("--foreground on each tint composited over background, card and secondary ≥ 4.5:1", () => {
        for (const tint of ["ok-tint", "warn-tint", "danger-tint"]) {
          for (const bg of ["background", "card", "secondary"]) {
            const surface = composite(tok(tint), tok(bg))
            const r = contrastRatio(tok("foreground"), surface)
            expect(r, `foreground on ${tint} over ${bg}`).toBeGreaterThanOrEqual(4.5)
          }
        }
      })

      it("status icons stay ≥ 3:1 on their own tint", () => {
        for (const s of ["ok", "warn", "danger"]) {
          const surface = composite(tok(`${s}-tint`), tok("card"))
          expect(contrastRatio(tok(s), surface), `${s} on ${s}-tint`).toBeGreaterThanOrEqual(3)
        }
      })
    })
  }
})

/** `oklch(L C H [/ A])` → OKLab (a, b from chroma and hue); for perceptual distances between tokens. */
function oklab(value: string): { L: number; a: number; b: number; h: number } {
  const m = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(value.trim())
  if (!m) throw new Error(`Not an oklch() colour: ${value}`)
  const [L, C, h] = [Number(m[1]), Number(m[2]), Number(m[3])]
  return { L, a: C * Math.cos((h * Math.PI) / 180), b: C * Math.sin((h * Math.PI) / 180), h }
}
const deltaE = (x: string, y: string) => {
  const p = oklab(x)
  const q = oklab(y)
  return Math.hypot(p.L - q.L, p.a - q.a, p.b - q.b)
}
const hueGap = (x: string, y: string) => {
  const d = Math.abs(oklab(x).h - oklab(y).h) % 360
  return Math.min(d, 360 - d)
}

describe("Rosa theme semantics (bubblegum: white text on saturated pink, candy accents)", () => {
  const r = themes.rosa
  const tok = (n: string) => parseOklch(r[n])
  const surfaces = ["background", "card", "secondary", "muted", "popover"]
  const ratio = (fg: string, bg: string) => contrastRatio(composite(tok(fg), tok(bg)), tok(bg))

  it("is a dark scheme: saturated pink surfaces and near-white text", () => {
    for (const n of ["background", "card", "popover", "secondary", "muted"]) {
      const c = oklab(r[n])
      expect(c.h >= 330 || c.h <= 10, `--${n} hue ${c.h}`).toBe(true)
      expect(Math.hypot(c.a, c.b), `--${n} chroma`).toBeGreaterThanOrEqual(0.12)
      expect(c.L, `--${n} lightness`).toBeLessThan(0.5)
    }
    expect(oklab(r.foreground).L).toBeGreaterThanOrEqual(0.95)
    expect(oklab(r["primary-foreground"]).L, "primary buttons carry dark text on a light candy fill").toBeLessThan(0.35)
    expect(css).toMatch(/\[data-theme="rosa"\]\s*\{\s*color-scheme:\s*dark;/)
  })

  it("muted and faint text ≥ 4.5:1 on every surface, including muted wells and popovers", () => {
    for (const bg of surfaces) {
      for (const fg of ["foreground", "muted-foreground", "faint-foreground"]) {
        expect(ratio(fg, bg), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  it("status colours and links are readable as text (≥ 4.5:1) on every surface", () => {
    for (const bg of surfaces) {
      for (const fg of ["brand", "ok", "warn", "danger"]) expect(ratio(fg, bg), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it("control outlines (--input, --control-border) and the focus ring ≥ 3:1 on every surface", () => {
    for (const bg of surfaces) {
      for (const fg of ["input", "control-border", "ring"]) expect(ratio(fg, bg), `${fg} on ${bg}`).toBeGreaterThanOrEqual(3)
    }
  })

  it("text on the status and brand tints ≥ 4.5:1 (also over popovers), and each icon ≥ 3:1 on its tint", () => {
    for (const s of ["ok", "warn", "danger", "brand"]) {
      for (const bg of ["background", "card", "secondary", "popover"]) {
        const surface = composite(tok(`${s}-tint`), tok(bg))
        expect(contrastRatio(tok("foreground"), surface), `foreground on ${s}-tint over ${bg}`).toBeGreaterThanOrEqual(4.5)
        expect(contrastRatio(tok(s), surface), `${s} on ${s}-tint over ${bg}`).toBeGreaterThanOrEqual(3)
      }
    }
  })

  it("candy accents (mine / primary / focus) never blend into the pink", () => {
    for (const accent of ["brand", "primary", "ring"]) {
      expect(hueGap(r[accent], r.background), `hue gap ${accent} vs background`).toBeGreaterThanOrEqual(60)
      expect(ratio(accent, "card"), `${accent} on card`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it("danger is unmistakable: tangerine text/icons, apart from the pink, the accent and warn; liquorice fills", () => {
    // Tangerine (hue 30–70), not a pink: a clear hue gap from every pink surface and every candy accent.
    expect(oklab(r.danger).h).toBeGreaterThanOrEqual(30)
    expect(oklab(r.danger).h).toBeLessThanOrEqual(70)
    for (const other of ["background", "card", "popover", "brand", "primary", "ring"]) {
      expect(hueGap(r.danger, r[other]), `hue gap danger vs ${other}`).toBeGreaterThanOrEqual(45)
      expect(deltaE(r.danger, r[other]), `ΔE danger vs ${other}`).toBeGreaterThanOrEqual(0.1)
    }
    // Fills and tints are dark liquorice: far darker than any pink surface, so a danger chip or button never reads as
    // one more pink panel.
    for (const bg of ["background", "card", "popover"]) {
      expect(oklab(r[bg]).L - oklab(r["danger-fill"]).L, `danger-fill darker than ${bg}`).toBeGreaterThanOrEqual(0.15)
      expect(contrastRatio(composite(tok("danger-tint"), tok(bg)), tok(bg)), `danger-tint stands out on ${bg}`).toBeGreaterThanOrEqual(1.5)
    }
    expect(ratio("danger-fill-foreground", "danger-fill")).toBeGreaterThanOrEqual(7)
    expect(contrastRatio(tok("danger"), tok("danger-fill")), "danger text on its liquorice label").toBeGreaterThanOrEqual(7)
  })

  it("status hues stay apart from each other and from the accent", () => {
    const status = ["ok", "warn", "danger", "brand"]
    for (const x of status) {
      for (const y of status) if (x < y) expect(deltaE(r[x], r[y]), `ΔE ${x} vs ${y}`).toBeGreaterThanOrEqual(0.12)
    }
  })

  it("gummy corners: chips 8, controls 12, panels 16 px (the other themes keep 4 / 6 / 8)", () => {
    expect([r["rm-radius-sm"], r["rm-radius-md"], r["rm-radius-lg"]]).toEqual(["8px", "12px", "16px"])
    expect(themes.dark["rm-radius-sm"]).toBeUndefined()
    expect(themes.light["rm-radius-sm"]).toBeUndefined()
  })

  it("candy motion is off with prefers-reduced-motion (the stripes march only under no-preference)", () => {
    const flat = css.replace(/\/\*[\s\S]*?\*\//g, "")
    const uses = [...flat.matchAll(/animation:\s*rm-candy-march[^;]*;/g)]
    expect(uses.length).toBeGreaterThan(0)
    const guarded = /@media \(prefers-reduced-motion: no-preference\)\s*\{\s*\[data-theme="rosa"\] \[data-slot="progress-indicator"\]\s*\{\s*animation:\s*rm-candy-march/
    expect(flat).toMatch(guarded)
    expect(uses.length).toBe(1)
  })
})
