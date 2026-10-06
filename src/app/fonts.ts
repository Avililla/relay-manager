// Self-hosted Atkinson Hyperlegible Next + Mono (D19, §8.3). The woff2 files are committed under src/fonts/
// (scripts/vendor-fonts.sh); nothing is fetched at build or run time. Both `.variable` classes go on <html>.
import localFont from "next/font/local"

export const sansFont = localFont({
  src: [
    { path: "../fonts/atkinson-hyperlegible-next-latin-wght-normal.woff2", weight: "200 800", style: "normal" },
    { path: "../fonts/atkinson-hyperlegible-next-latin-wght-italic.woff2", weight: "200 800", style: "italic" },
  ],
  variable: "--font-sans-family",
  display: "swap",
  fallback: ["system-ui", "sans-serif"],
})

export const monoFont = localFont({
  src: [{ path: "../fonts/atkinson-hyperlegible-mono-latin-wght-normal.woff2", weight: "200 800", style: "normal" }],
  variable: "--font-mono-family",
  display: "swap",
  // The default metric fallback would put an Arial-metric proportional face first: keep real monospace fallbacks.
  adjustFontFallback: false,
  fallback: ["DejaVu Sans Mono", "ui-monospace", "monospace"],
})
