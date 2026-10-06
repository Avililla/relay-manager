#!/usr/bin/env node
// Capturas de pantalla de los manuales. Los manuales (HTML, imágenes y etapas) son del proyecto y viven en su perfil:
// --manuales <carpeta> (por ejemplo <perfil>/manuales) tiene que contener etapas.mjs, que exporta STAGES (y puede
// tener banco.json con los nombres de host de las consolas simuladas, ver entorno.mjs).
//
//   node scripts/manuales/capturas.mjs --manuales <carpeta> [--perfil <carpeta>] [--dir <carpeta>] [--port 3200]
//                                      [--data-link <enlace>] [--tools-link <enlace>] [--files-link <enlace>]
//                                      [--contenedor] [etapa…]
//
// --perfil: el perfil que carga el servidor (RM_PROFILE_DIR); por defecto, la carpeta que contiene a --manuales si
// tiene perfil.env o plantillas/. Las etapas importan las ayudas de este repositorio con process.env.RM_REPO.
//
// Sin etapas: monta el entorno de demostración desde cero (entorno.mjs: banco simulado, sysfs falso y servidor
// compilado con datos vacíos), recorre todas las etapas en orden (configuración inicial, datos de ejemplo por la
// propia interfaz y capturas) y lo detiene todo. Con etapas: las ejecuta contra un entorno ya en marcha
// (node scripts/manuales/entorno.mjs --dir <carpeta>), útil para repetir una sola captura. Los Chrome abren la web
// como http://192.0.2.97:3200 (la dirección de ejemplo de los manuales) a través del proxy del entorno.
// --contenedor: el entorno corre en Docker con red propia (contenedor.mjs), así que la red de equipos se prepara de
// verdad («Lista»); sin él, el servidor no puede cambiar la red y Sistema › Red de equipos sale «Sin permiso».
// Las capturas salen en <carpeta>/shots/*.png (1440×900 a escala 2); optimizar.mjs las pasa a JPEG en <manuales>/img.
// Necesita `pnpm build` hecho, python3 y Google Chrome.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { ADAPTERS, SETUP_TOKEN, startEnv } from "./entorno.mjs"
import { startContainerEnv } from "./contenedor.mjs"
import { plugCable, unplugCable } from "../sim/fake-jtag-cable.mjs"
import { browserFor, killBrowsers } from "./navegador.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, "..", "..")

function parseArgs(argv) {
  const o = { manuales: null, perfil: null, dir: null, port: 3200, dataLink: null, toolsLink: null, filesLink: null, container: false, stages: [] }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dir") o.dir = argv[++i]
    else if (argv[i] === "--port") o.port = Number(argv[++i])
    else if (argv[i] === "--data-link") o.dataLink = path.resolve(argv[++i])
    else if (argv[i] === "--tools-link") o.toolsLink = path.resolve(argv[++i])
    else if (argv[i] === "--files-link") o.filesLink = path.resolve(argv[++i])
    else if (argv[i] === "--contenedor") o.container = true
    else if (argv[i] === "--manuales") o.manuales = path.resolve(argv[++i])
    else if (argv[i] === "--perfil") o.perfil = path.resolve(argv[++i])
    else o.stages.push(argv[i])
  }
  return o
}

const o = parseArgs(process.argv.slice(2))
if (!o.manuales || !fs.existsSync(path.join(o.manuales, "etapas.mjs"))) {
  throw new Error("Uso: capturas.mjs --manuales <carpeta con etapas.mjs> [--perfil <carpeta>] [--dir <carpeta>] … [etapa…]")
}
if (!o.perfil) {
  const up = path.dirname(o.manuales)
  if (fs.existsSync(path.join(up, "perfil.env")) || fs.existsSync(path.join(up, "plantillas"))) o.perfil = up
}
process.env.RM_REPO = REPO
const { STAGES } = await import(pathToFileURL(path.join(o.manuales, "etapas.mjs")).href)
const full = o.stages.length === 0
const root = path.resolve(o.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), "rm-manuales-")))
let envh = null
if (full) {
  if (fs.existsSync(path.join(root, "data", "relay-manager.db"))) throw new Error(`${root} ya tiene datos: usa una carpeta vacía`)
  const links = { dataLink: o.dataLink, toolsLink: o.toolsLink, filesLink: o.filesLink, perfil: o.perfil, manuales: o.manuales }
  envh = o.container
    ? await startContainerEnv({ dir: root, port: o.port, ...links })
    : await startEnv({ dir: root, port: o.port, ctlPort: o.port + 89, proxyPort: o.port + 98, ...links })
}
const info = JSON.parse(fs.readFileSync(path.join(root, "entorno.json"), "utf8"))
const shots = path.join(root, "shots")
fs.mkdirSync(shots, { recursive: true })

const ctx = {
  root, base: info.base, local: info.local, ctl: info.ctl, dataDir: info.dataDir, shots, token: SETUP_TOKEN, adapters: ADAPTERS, repo: REPO,
  host: new URL(info.base).hostname, jtagRoot: info.jtagRoot, proxy: info.proxy,
  /** Red de equipos: "contenedor" (el servidor la prepara de verdad) o "sin-permiso". */
  net: info.net ?? "sin-permiso",
  /** Carpeta real de Archivos (RM_FILES_DIR apunta a ella o a su enlace). */
  filesDir: info.filesReal ?? path.join(root, "tftp"),
  /** Segunda carpeta compartida (RM_FILES_EXTRA_DIR; solo aparece si el perfil la activa). */
  extraDir: info.extraDir ?? path.join(root, "extra"),
  /** Carpeta de los manuales del proyecto (etapas.mjs, *.html, img/). */
  manuales: o.manuales,
  browsers: {},
  /** Sockets abiertos por las etapas (sesiones remotas simuladas); se cierran al acabar. */
  sockets: new Set(),
  plugJtag(serial, port, xilinx = false) { plugCable(info.jtagRoot, { serial, port, xilinx }) },
  unplugJtag(serial) { unplugCable(info.jtagRoot, serial) },
  /** Chrome de cada persona: admin (9301), jorge (9302), lucia (9303). */
  async page(who) {
    if (!this.browsers[who]) this.browsers[who] = await browserFor(root, who, { admin: 9301, jorge: 9302, lucia: 9303, nuevo: 9304 }[who], { proxy: info.proxy })
    return this.browsers[who].page
  },
  async control(p) {
    const r = await fetch(`${this.ctl}${p}`)
    if (!r.ok) throw new Error(`control ${p}: ${r.status} ${await r.text()}`)
    return r.json()
  },
}

const names = full ? Object.keys(STAGES) : o.stages
let failed = false
for (const n of names) {
  const fn = STAGES[n]
  if (!fn) throw new Error(`Etapa desconocida: ${n}. Etapas: ${Object.keys(STAGES).join(", ")}`)
  const t = Date.now()
  process.stdout.write(`==> ${n}\n`)
  try {
    await fn(ctx)
    process.stdout.write(`    ok (${((Date.now() - t) / 1000).toFixed(1)} s)\n`)
  } catch (e) {
    failed = true
    process.stdout.write(`    FALLO: ${e?.stack ?? e}\n`)
    for (const [who, b] of Object.entries(ctx.browsers)) await b.page.screenshot({ path: path.join(shots, `_fallo-${n}-${who}.png`) }).catch(() => {})
    break
  }
}
for (const s of ctx.sockets) s.destroy()
if (full) {
  killBrowsers(root)
  await envh.stop()
  if (o.dataLink) fs.rmSync(o.dataLink, { force: true })
  if (o.toolsLink) fs.rmSync(o.toolsLink, { force: true })
  if (o.filesLink) fs.rmSync(o.filesLink, { force: true })
  process.stdout.write(`Capturas en ${shots}\n`)
}
process.exit(failed ? 1 : 0)
