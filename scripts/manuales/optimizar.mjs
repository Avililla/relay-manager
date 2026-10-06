#!/usr/bin/env node
// Pasa a JPEG las capturas que usan los manuales y las deja en <manuales>/img (con sus .marcas.json).
// <manuales> es la carpeta de los manuales del proyecto, dentro de su perfil (por ejemplo <perfil>/manuales).
//
//   node scripts/manuales/optimizar.mjs --manuales <carpeta> <carpeta de capturas> [--calidad 88] [--ancho 2200]
//
// Solo convierte las imágenes que aparecen en <manuales>/*.html (img/<nombre>.jpg). La conversión la hace el
// propio Chrome (canvas → JPEG), así que no hace falta ninguna herramienta de imagen. JPEG y no WebP porque el PDF
// guarda el JPEG tal cual, mientras que un WebP lo vuelve a codificar sin pérdida y el PDF pesa cinco veces más. Las capturas más anchas que
// --ancho píxeles se reducen (las de 1440 px a escala 2 quedan en 2200 px: nítidas en A4 y ligeras).
import fs from "node:fs"
import path from "node:path"
import { chromium } from "playwright-core"
import { chromePath } from "./navegador.mjs"


async function main() {
  const args = process.argv.slice(2)
  let src = null
  let quality = 88
  let maxWidth = 2200
  let DOCS = process.env.RM_MANUALES_DIR ? path.resolve(process.env.RM_MANUALES_DIR) : null
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--calidad") quality = Number(args[++i])
    else if (args[i] === "--ancho") maxWidth = Number(args[++i])
    else if (args[i] === "--manuales") DOCS = path.resolve(args[++i])
    else src = path.resolve(args[i])
  }
  if (!src || !DOCS) throw new Error("Uso: optimizar.mjs --manuales <carpeta> <carpeta de capturas> [--calidad 88] [--ancho 2200]")
  const used = new Set()
  for (const f of fs.readdirSync(DOCS).filter((n) => n.endsWith(".html"))) {
    for (const m of fs.readFileSync(path.join(DOCS, f), "utf8").matchAll(/img\/([\w-]+)\.jpg/g)) used.add(m[1])
  }
  const out = path.join(DOCS, "img")
  fs.mkdirSync(out, { recursive: true })
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true })
  const page = await browser.newPage()
  let total = 0
  const missing = []
  for (const name of [...used].sort()) {
    const png = path.join(src, `${name}.png`)
    if (!fs.existsSync(png)) { missing.push(name); continue }
    const dataUrl = `data:image/png;base64,${fs.readFileSync(png).toString("base64")}`
    const jpg = await page.evaluate(async ({ dataUrl, quality, maxWidth }) => {
      const img = new Image()
      img.src = dataUrl
      await img.decode()
      const scale = Math.min(1, maxWidth / img.naturalWidth)
      const c = document.createElement("canvas")
      c.width = Math.round(img.naturalWidth * scale)
      c.height = Math.round(img.naturalHeight * scale)
      const g = c.getContext("2d")
      g.imageSmoothingQuality = "high"
      g.drawImage(img, 0, 0, c.width, c.height)
      return c.toDataURL("image/jpeg", quality / 100)
    }, { dataUrl, quality, maxWidth })
    const buf = Buffer.from(jpg.split(",")[1], "base64")
    fs.writeFileSync(path.join(out, `${name}.jpg`), buf)
    total += buf.length
    const marks = path.join(src, `${name}.marcas.json`)
    if (fs.existsSync(marks)) fs.copyFileSync(marks, path.join(out, `${name}.marcas.json`))
    else fs.rmSync(path.join(out, `${name}.marcas.json`), { force: true })
  }
  await browser.close()
  // Imágenes que ya no usa ningún manual.
  for (const f of fs.readdirSync(out)) {
    const base = f.replace(/\.(jpg|webp|png|marcas\.json)$/, "")
    if (!used.has(base)) fs.rmSync(path.join(out, f))
  }
  process.stdout.write(`${used.size - missing.length} imágenes, ${(total / 1024 / 1024).toFixed(1)} MB en ${path.relative(process.cwd(), out)}\n`)
  if (missing.length) {
    process.stdout.write(`Faltan capturas: ${missing.join(", ")}\n`)
    process.exitCode = 1
  }
}

main().catch((e) => { process.stderr.write(`Error: ${e?.stack ?? e}\n`); process.exit(1) })
