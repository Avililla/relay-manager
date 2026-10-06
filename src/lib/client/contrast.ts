// OKLCH → sRGB and WCAG contrast (§8.2 contrast test). Pure; used by the token test and available to tooling.

/** Gamma-encoded sRGB channels in 0..1 plus alpha. */
export interface Rgba { r: number; g: number; b: number; a: number }

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
const encode = (x: number) => (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055)
const decode = (x: number) => (x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4))

/** Parses `oklch(L C H [/ A])` (L as 0..1 or %, A as 0..1 or %) and clips to the sRGB gamut. */
export function parseOklch(value: string): Rgba {
  const m = /^oklch\(\s*([\d.]+%?)\s+([\d.]+)\s+([\d.]+)(?:deg)?\s*(?:\/\s*([\d.]+%?))?\s*\)$/i.exec(value.trim())
  if (!m) throw new Error(`Not an oklch() colour: ${value}`)
  const pct = (s: string) => (s.endsWith("%") ? Number(s.slice(0, -1)) / 100 : Number(s))
  const L = pct(m[1])
  const C = Number(m[2])
  const h = (Number(m[3]) * Math.PI) / 180
  const a = C * Math.cos(h)
  const b = C * Math.sin(h)
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b
  const s_ = L - 0.0894841775 * a - 1.291485548 * b
  const l3 = l_ ** 3
  const m3 = m_ ** 3
  const s3 = s_ ** 3
  const R = 4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3
  const G = -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3
  const B = -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3
  return { r: clamp01(encode(R)), g: clamp01(encode(G)), b: clamp01(encode(B)), a: m[4] === undefined ? 1 : clamp01(pct(m[4])) }
}

/** Source-over compositing in gamma space (how browsers blend sRGB colours). */
export function composite(fg: Rgba, bg: Rgba): Rgba {
  const a = fg.a + bg.a * (1 - fg.a)
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 }
  const mix = (f: number, b: number) => (f * fg.a + b * bg.a * (1 - fg.a)) / a
  return { r: mix(fg.r, bg.r), g: mix(fg.g, bg.g), b: mix(fg.b, bg.b), a }
}

export function relativeLuminance(c: Rgba): number {
  return 0.2126 * decode(c.r) + 0.7152 * decode(c.g) + 0.0722 * decode(c.b)
}

export function contrastRatio(x: Rgba, y: Rgba): number {
  const a = relativeLuminance(x)
  const b = relativeLuminance(y)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

export const THEME_NAMES = ["dark", "light", "rosa"] as const
export type ThemeName = (typeof THEME_NAMES)[number]
export type ThemeTokens = Record<ThemeName, Record<string, string>>

const THEME_SELECTORS = new Map<string, ThemeName>([
  [":root,[data-theme=\"dark\"]", "dark"],
  ["[data-theme=\"light\"]", "light"],
  ["[data-theme=\"rosa\"]", "rosa"],
])

/**
 * Reads the custom properties of the theme blocks of globals.css: `:root, [data-theme="dark"] { … }`,
 * `[data-theme="light"] { … }` and `[data-theme="rosa"] { … }` (flat blocks only). `var(--x)` references are
 * resolved inside the same block.
 */
export function extractThemeTokens(css: string): ThemeTokens {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "")
  const out: ThemeTokens = { dark: {}, light: {}, rosa: {} }
  const block = /([^{}]+)\{([^{}]*)\}/g
  for (let m = block.exec(clean); m; m = block.exec(clean)) {
    // The text before "{" may still carry the end of a previous at-rule ("…);"): keep the part after the last ";".
    const selector = (m[1].split(";").pop() ?? "").replace(/\s+/g, "").replace(/'/g, "\"")
    const theme = THEME_SELECTORS.get(selector)
    if (!theme) continue
    for (const d of m[2].split(";")) {
      const i = d.indexOf(":")
      if (i < 0) continue
      const name = d.slice(0, i).trim()
      if (name.startsWith("--")) out[theme][name.slice(2)] = d.slice(i + 1).trim()
    }
  }
  for (const t of THEME_NAMES) {
    for (const [k, v] of Object.entries(out[t])) {
      let val = v
      for (let depth = 0; depth < 5; depth++) {
        const ref = /^var\(--([\w-]+)\)$/.exec(val)
        if (!ref || !out[t][ref[1]]) break
        val = out[t][ref[1]]
      }
      out[t][k] = val
    }
  }
  return out
}
