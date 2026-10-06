#!/usr/bin/env node
// Genera los manuales en PDF desde <manuales>/*.html con el Chrome del sistema (playwright-core). Los manuales son
// del proyecto y viven en su perfil (por ejemplo <perfil>/manuales), fuera de este repositorio.
//
//   node scripts/manuales/generar.mjs --manuales <carpeta> [--out <carpeta>] [usuario] [administrador]
//
// <manuales>/manuales.json (opcional) da el nombre del producto de la cabecera y los ficheros:
//   { "producto": "Mi banco", "manuales": { "usuario": { "pdf": "Manual_Usuario.pdf" }, "administrador": { … } } }
// Las fuentes (Atkinson Hyperlegible) se cargan desde src/fonts/ de este repositorio.
// Por defecto escribe en dist/manuales/. En la página: numera capítulos, apartados y figuras, construye el índice,
// resuelve las referencias cruzadas (<a class="ref" href="#id">) y pinta las llamadas numeradas de las capturas
// (img/<nombre>.marcas.json). Cabecera, pie y «Página N de M» son cajas de margen de CSS (la portada no las lleva).
// Con pdftotext (poppler-utils) pone los números de página en el índice; sin él, el índice queda sin números.
// El PDF sale con título, marcadores (índice lateral) y etiquetas de accesibilidad.
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { chromium } from "playwright-core"
import { chromePath } from "./navegador.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, "..", "..")
let SRC = null
let PRODUCTO = "Relay Manager"
const FONTS = path.join(REPO, "src", "fonts")
const VERSION = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8")).version

export const MANUALES = {
  usuario: { html: "usuario.html", pdf: "Manual_Usuario_Relay_Manager.pdf", titulo: "Manual de usuario" },
  administrador: { html: "administrador.html", pdf: "Manual_Administrador_Relay_Manager.pdf", titulo: "Manual de administrador" },
}

const has = (cmd) => spawnSync("sh", ["-c", `command -v ${cmd}`], { stdio: "ignore" }).status === 0

function marksFor(html) {
  const out = {}
  for (const m of html.matchAll(/img\/([\w-]+)\.(?:jpg|webp|png)/g)) {
    const f = path.join(SRC, "img", `${m[1]}.marcas.json`)
    if (fs.existsSync(f)) out[m[1]] = JSON.parse(fs.readFileSync(f, "utf8"))
  }
  return out
}

/** Se ejecuta en la página: numeración, índice, referencias, figuras y llamadas. */
function prepare({ marks }) {
  const toc = document.querySelector("nav.indice > ol")
  let ch = 0
  for (const sec of document.querySelectorAll("section.capitulo")) {
    const h2 = sec.querySelector("h2")
    ch++
    if (!h2.id) h2.id = `cap-${ch}`
    h2.dataset.num = String(ch)
    h2.insertAdjacentHTML("afterbegin", `<span class="num">${ch}</span>`)
    const li = document.createElement("li")
    li.innerHTML = `<a href="#${h2.id}"><span class="n">${ch}</span><span class="t"></span><span class="puntos"></span><span class="p" data-for="${h2.id}"></span></a>`
    li.querySelector(".t").textContent = h2.dataset.titulo ?? h2.textContent.replace(/^\d+/, "").trim()
    let sub = 0
    const ol = document.createElement("ol")
    for (const h3 of sec.querySelectorAll("h3")) {
      sub++
      const n = `${ch}.${sub}`
      if (!h3.id) h3.id = `ap-${n}`
      h3.dataset.num = n
      h3.insertAdjacentHTML("afterbegin", `<span class="num">${n}</span>`)
      const l2 = document.createElement("li")
      l2.innerHTML = `<a href="#${h3.id}"><span class="n">${n}</span><span class="t"></span><span class="puntos"></span><span class="p" data-for="${h3.id}"></span></a>`
      l2.querySelector(".t").textContent = h3.textContent.replace(/^[\d.]+/, "").trim()
      ol.append(l2)
    }
    if (sub && !sec.hasAttribute("data-sin-subindice")) li.append(ol)
    toc?.append(li)
  }
  let fig = 0
  const figNum = new Map()
  for (const f of document.querySelectorAll("figure")) {
    const cap = f.querySelector("figcaption")
    if (!cap) continue
    fig++
    if (f.id) figNum.set(f.id, fig)
    cap.insertAdjacentHTML("afterbegin", `<span class="fig">Figura ${fig}.</span>`)
  }
  for (const a of document.querySelectorAll("a.ref")) {
    const id = a.getAttribute("href").slice(1)
    let t = document.getElementById(id)
    if (t?.tagName === "SECTION") t = t.querySelector("h2")
    if (!t || (t.tagName !== "FIGURE" && !t.dataset.num)) { a.textContent = `¿${id}?`; a.style.color = "red"; continue }
    if (t.tagName === "FIGURE") a.textContent = `figura ${figNum.get(id)}`
    else a.textContent = `${t.tagName === "H2" ? "capítulo" : "apartado"} ${t.dataset.num}`
  }
  for (const img of document.querySelectorAll("figure img")) {
    const name = (img.getAttribute("src").match(/img\/([\w-]+)\./) ?? [])[1]
    const list = marks[name]
    if (!list || img.hasAttribute("data-sin-marcas")) continue
    const box = img.closest(".marco") ?? img.parentElement
    for (const m of list) {
      const s = document.createElement("span")
      s.className = "marca"
      s.textContent = String(m.n)
      // Cajas en % de la imagen; la llamada se pone junto al elemento (3,4 mm ≈ radio + separación).
      const w = m.w ?? 0
      const h = m.h ?? 0
      let pos = m.pos ?? "auto"
      if (pos === "auto") pos = w > 25 && h > 25 ? "centro" : m.x > 4 ? "izquierda" : "derecha"
      const cx = `${m.x + w / 2}%`
      const cy = `${m.y + h / 2}%`
      const at = {
        izquierda: [`calc(${m.x}% - 3.4mm)`, cy],
        derecha: [`calc(${m.x + w}% + 3.4mm)`, cy],
        arriba: [cx, `calc(${m.y}% - 3.2mm)`],
        abajo: [cx, `calc(${m.y + h}% + 3.2mm)`],
        centro: [cx, cy],
      }[pos] ?? [`${m.x}%`, `${m.y}%`]
      s.style.left = at[0]
      s.style.top = at[1]
      box.append(s)
    }
  }
  const missing = [...document.querySelectorAll("a.ref")].filter((a) => a.textContent.startsWith("¿")).map((a) => a.textContent)
  return { chapters: ch, figures: fig, missing }
}

async function waitAssets(page) {
  await page.evaluate(async () => {
    await document.fonts.ready
    await Promise.all([...document.images].map((i) => (i.complete ? null : new Promise((r) => { i.onload = r; i.onerror = r }))))
  })
}

/** Lee la carpeta de los manuales y su manuales.json (opcional). */
function loadManuales(dir) {
  SRC = path.resolve(dir)
  if (!fs.existsSync(SRC)) throw new Error(`No existe la carpeta de los manuales: ${SRC}`)
  const cfgFile = path.join(SRC, "manuales.json")
  if (!fs.existsSync(cfgFile)) return
  const cfg = JSON.parse(fs.readFileSync(cfgFile, "utf8"))
  if (typeof cfg.producto === "string" && cfg.producto.trim()) PRODUCTO = cfg.producto.trim()
  for (const [k, v] of Object.entries(cfg.manuales ?? {})) MANUALES[k] = { ...MANUALES[k], ...v }
}

/** Las fuentes del repositorio (src/fonts), por URL file:// absoluta. */
function fontsCss() {
  const url = (f) => JSON.stringify(pathToFileURL(path.join(FONTS, f)).href)
  return `
  @font-face { font-family: "Atkinson Next"; src: url(${url("atkinson-hyperlegible-next-latin-wght-normal.woff2")}) format("woff2"); font-weight: 200 800; font-style: normal; }
  @font-face { font-family: "Atkinson Next"; src: url(${url("atkinson-hyperlegible-next-latin-wght-italic.woff2")}) format("woff2"); font-weight: 200 800; font-style: italic; }
  @font-face { font-family: "Atkinson Mono"; src: url(${url("atkinson-hyperlegible-mono-latin-wght-normal.woff2")}) format("woff2"); font-weight: 200 800; }`
}

/** Cabecera y pie como cajas de margen de CSS (@page): la portada, con margen 0, queda limpia. */
function headerFooterCss(titulo, fecha) {
  const q = (t) => JSON.stringify(t)
  const box = "font-family: 'Atkinson Next', sans-serif; font-size: 7.5pt; color: #7a8595;"
  return `@page {
    @top-left { content: ${q(`${PRODUCTO} · ${titulo}`)}; ${box} vertical-align: bottom; padding-bottom: 4mm; }
    @top-right { content: ${q(`Versión ${VERSION}`)}; ${box} vertical-align: bottom; padding-bottom: 4mm; }
    @bottom-left { content: ${q(fecha)}; ${box} vertical-align: top; padding-top: 4mm; }
    @bottom-right { content: "Página " counter(page) " de " counter(pages); ${box} vertical-align: top; padding-top: 4mm; }
  }
  @page portada { @top-left { content: none; } @top-right { content: none; } @bottom-left { content: none; } @bottom-right { content: none; } }`
}

/** Página de cada entrada del índice a partir del texto del PDF (los títulos numerados empiezan línea). */
function pageMap(pdfFile, entries) {
  const r = spawnSync("pdftotext", ["-layout", pdfFile, "-"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
  if (r.status !== 0) return null
  const pages = r.stdout.split("\f")
  const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+")
  const reOf = (e) => new RegExp(`^\\s*${esc(e.num)}\\s*${esc(e.title)}`, "m")
  // El índice repite los títulos: el capítulo 1 empieza en la última página donde aparece su título.
  const re1 = reOf(entries[0])
  let start = 0
  pages.forEach((p, i) => { if (re1.test(p)) start = i })
  const out = {}
  for (const e of entries) {
    const re = reOf(e)
    const idx = pages.findIndex((p, i) => i >= start && re.test(p))
    if (idx >= 0) out[e.id] = idx + 1
  }
  return out
}

async function render(browser, key, outDir) {
  const m = MANUALES[key]
  const file = path.join(SRC, m.html)
  const html = fs.readFileSync(file, "utf8")
  const fecha = (html.match(/<meta name="fecha" content="([^"]+)"/) ?? [])[1] ?? ""
  const page = await browser.newPage()
  await page.goto(pathToFileURL(file).href)
  await page.addStyleTag({ content: fontsCss() })
  await waitAssets(page)
  const info = await page.evaluate(prepare, { marks: marksFor(html) })
  if (info.missing.length) process.stdout.write(`    Aviso: referencias sin destino: ${info.missing.join(", ")}\n`)
  await waitAssets(page)
  await page.addStyleTag({ content: headerFooterCss(m.titulo, fecha) })
  const out = path.join(outDir, m.pdf)
  const pdfOpts = { path: out, format: "A4", preferCSSPageSize: true, printBackground: true, outline: true, tagged: true }
  await page.pdf(pdfOpts)
  if (has("pdftotext")) {
    const entries = await page.evaluate(() => [...document.querySelectorAll("nav.indice .p[data-for]")].map((s) => {
      const h = document.getElementById(s.dataset.for)
      return { id: s.dataset.for, num: h.dataset.num, title: h.textContent.replace(/^[\d.]+/, "").trim() }
    }))
    // Dos pasadas: poner los números puede mover alguna línea del índice (en la práctica, no cambia nada).
    for (let pass = 0; pass < 2; pass++) {
      const map = pageMap(out, entries)
      if (!map) break
      const changed = await page.evaluate((mp) => {
        let c = false
        for (const s of document.querySelectorAll("nav.indice .p[data-for]")) {
          const v = String(mp[s.dataset.for] ?? "")
          if (s.textContent !== v) { s.textContent = v; c = true }
        }
        return c
      }, map)
      if (!changed) break
      await page.pdf(pdfOpts)
    }
  }
  await page.close()
  return { out, ...info }
}

async function main() {
  const args = process.argv.slice(2)
  let outDir = path.join(REPO, "dist", "manuales")
  const which = []
  const uso = "Uso: generar.mjs --manuales <carpeta> [--out <carpeta>] [usuario] [administrador]"
  const mi = args.indexOf("--manuales")
  const dir = mi >= 0 ? args[mi + 1] : process.env.RM_MANUALES_DIR
  if (!dir) throw new Error(`Falta --manuales (o RM_MANUALES_DIR). ${uso}`)
  loadManuales(dir)
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--out") outDir = path.resolve(args[++i])
    else if (args[i] === "--manuales") i++
    else if (MANUALES[args[i]]) which.push(args[i])
    else throw new Error(`Argumento desconocido: ${args[i]}. ${uso}`)
  }
  fs.mkdirSync(outDir, { recursive: true })
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true })
  try {
    for (const key of which.length ? which : Object.keys(MANUALES)) {
      const r = await render(browser, key, outDir)
      process.stdout.write(`${path.relative(process.cwd(), r.out) || r.out}: ${r.chapters} capítulos, ${r.figures} figuras\n`)
    }
  } finally {
    await browser.close()
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { process.stderr.write(`Error al generar los manuales: ${e?.stack ?? e}\n`); process.exit(1) })
}
