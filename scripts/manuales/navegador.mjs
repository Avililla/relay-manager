// Navegadores para las capturas de los manuales: un Chrome sin interfaz por persona (administración y operadores),
// cada uno con su perfil, así las sesiones sobreviven entre ejecuciones de capturas.mjs. Se conectan por CDP.
import { spawn } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import { chromium } from "playwright-core"

export const WIDTH = 1440
export const HEIGHT = 900
export const SCALE = 2

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const canConnect = (port) => new Promise((resolve) => {
  const s = net.connect({ host: "127.0.0.1", port })
  const done = (v) => { s.destroy(); resolve(v) }
  s.setTimeout(300, () => done(false))
  s.once("connect", () => done(true))
  s.once("error", () => done(false))
})

export function chromePath() {
  const c = [process.env.RM_E2E_CHROME, "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].filter(Boolean)
  const found = c.find((p) => fs.existsSync(p))
  if (!found) throw new Error(`No se encuentra Chrome (${c.join(", ")})`)
  return found
}

function registry(root) {
  const f = path.join(root, "chromes.json")
  return { f, data: fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {} }
}

/**
 * Arranca (si no lo está ya) el Chrome de `who` y se conecta. Devuelve { browser, context, page }. `proxy`: proxy HTTP
 * por el que abre la web con la IP de ejemplo de los manuales (entorno.mjs).
 */
export async function browserFor(root, who, cdpPort, { proxy = null } = {}) {
  const reg = registry(root)
  if (!(await canConnect(cdpPort))) {
    const profile = path.join(root, `chrome-${who}`)
    const ch = spawn(chromePath(), [
      "--headless=new", `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`,
      `--window-size=${WIDTH},${HEIGHT}`, `--force-device-scale-factor=${SCALE}`, "--hide-scrollbars",
      "--no-first-run", "--no-default-browser-check", "--disable-features=Translate,MediaRouter", "--lang=es-ES",
      "--font-render-hinting=none", ...(proxy ? [`--proxy-server=${proxy}`] : []), "about:blank",
    ], { stdio: "ignore", detached: true, env: { ...process.env, LANG: "es_ES.UTF-8", TZ: process.env.TZ ?? "Europe/Madrid" } })
    ch.unref()
    reg.data[who] = { pid: ch.pid, port: cdpPort }
    fs.writeFileSync(reg.f, JSON.stringify(reg.data, null, 2))
    for (let i = 0; i < 50 && !(await canConnect(cdpPort)); i++) await sleep(200)
  }
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`)
  const context = browser.contexts()[0]
  const page = context.pages().find((p) => !p.url().startsWith("devtools")) ?? (await context.newPage())
  await emulate(page, { width: WIDTH, height: HEIGHT })
  return { browser, context, page }
}

/** Tamaño y escala de la ventana por CDP (setViewportSize de Playwright sobre CDP deja devicePixelRatio en 1). */
export async function emulate(page, { width, height, scale = SCALE, mobile = false }) {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: scale, mobile, screenWidth: width, screenHeight: height })
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: mobile, maxTouchPoints: mobile ? 5 : 1 })
  // La sesión CDP se queda abierta: al cerrarla, Chrome quita la emulación.
  page.rmSize = { width, height }
  page.rmCdp = cdp
}

/** Cierra todos los Chrome de las capturas (por PID). */
export function killBrowsers(root) {
  const reg = registry(root)
  for (const [who, { pid }] of Object.entries(reg.data)) {
    try { process.kill(pid, "SIGTERM") } catch { /* ya no está */ }
    delete reg.data[who]
  }
  fs.writeFileSync(reg.f, JSON.stringify(reg.data, null, 2))
}
