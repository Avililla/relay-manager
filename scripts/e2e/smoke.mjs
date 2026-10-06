#!/usr/bin/env node
// E2E smoke test (§11.4, W3-I): `pnpm test:e2e` = node scripts/e2e/smoke.mjs [--keep] [--headed] [--perfil DIR]
//
// Builds the app if build/server.js is missing, starts the fake bench (4 fake Zynq consoles ttyV0..ttyV3 and one
// dS378 with ASCII + UDP on 127.0.0.2), runs the real server (`node build/server.js start`, portable mode, temp data
// dir) and drives the main flows with the system Chrome through playwright-core, plus protocol checks (HTTP, SSE,
// WebSocket, /proc fds and the simulator's own relay state). Every step saves a screenshot to test-results/e2e/.
// Exit code 0 means every step passed. Env: RM_E2E_CHROME (browser), RM_E2E_PORT (default 3999).
// The project profile (templates, second folder of Archivos, download script): examples/perfil-ejemplo, or another one
// with --perfil DIR (or RM_E2E_PROFILE). The wizard steps use its first template with 2 consoles, no relays and the 5
// accesses JTAG, JTAG, serial, serial, Ethernet by the switch. A project profile's download script is replaced by the
// fake one (it needs its network) unless RM_E2E_REAL_DOWNLOADER=1. The imported unit is generic (UART0 and UART1).
import { spawnSync } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import { chromium, firefox } from "playwright-core"
import {
  EXAMPLE_PROFILE, FAKE_DOWNLOADER, REPO, StepError, assert, asciiCommand, cli, equipmentName, fdsPointingAt, hostPart, HttpSession,
  loadProfile, makeTempDir, openConsoleWs, openSse, pickWizardTemplate, portIsFree, randomPort, reEsc, replugConsole, serverEnv, sleep,
  startFakeBench, startServer, stopFakeBench, waitFor,
} from "./lib.mjs"
import { FAKE_HW_SERVER, plugCable, unplugCable } from "../sim/fake-jtag-cable.mjs"
import { createFakeSwitch } from "../sim/fake-tplink-switch.mjs"
import { plugAdapter } from "../sim/fake-net-adapter.mjs"
import { createFakeSshServer } from "../sim/fake-ssh-server.mjs"

const argv = process.argv.slice(2)
const args = new Set(argv)
const KEEP = args.has("--keep")
const HEADED = args.has("--headed")
const PROFILE_DIR = argv.includes("--perfil") ? argv[argv.indexOf("--perfil") + 1]
  : (argv.find((a) => a.startsWith("--perfil="))?.slice("--perfil=".length) ?? process.env.RM_E2E_PROFILE ?? EXAMPLE_PROFILE)
if (!PROFILE_DIR) throw new Error("Falta la carpeta tras --perfil")
const PORT = Number(process.env.RM_E2E_PORT ?? 3999)
const RELAY_HOST = "127.0.0.2"
const ASCII_PORT = 17123
const HTTP_PORT = 18080
const UDP_PORT = randomPort(31000, 2000)
const TOKEN = "E2E0-E2E0-E2E0-E2E0"
const ADMIN = { username: "admin", name: "Administración E2E", password: "e2e-password-1" }
const OPER = { username: "operador", name: "Olga Operadora", firstPassword: "op-initial-pass-1", password: "op-password-2" }
const SHOTS = path.join(REPO, "test-results", "e2e")
const JTAG_SERIAL = "210299E2E001"
/**
 * Access ports for this run (RM_ACCESS_PORTS): 30 free ports, picked below the kernel's ephemeral range
 * (32768-60999 by default) so an outgoing connection of this or another process cannot be sitting on one of them.
 */
let ACCESS_BASE = randomPort(21_000, 8_000)
const BASE = `http://127.0.0.1:${PORT}`

const t0 = Date.now()
const results = []
let shotN = 0
const ctx = { tmp: null, bench: null, server: null, browser: null, pages: [], sse: null, sockets: [], echo: null, sw: null, ssh: null }
/** "Red de equipos": a fake USB network adapter (fake sysfs) and a fake TL-SG108E on 127.0.0.1. */
const NET_MAC = "02:00:00:00:e2:e2"

// What the profile decides, set in step 0: the profile, the wizard's template (TPL: its consoles C0/C1, accesses ACC,
// the suggested names EQ1/EQ2) and the effective values of the server's environment (EFF).
let PROFILE = null
let TPL = null
let C0 = ""
let C1 = ""
let ACC = []
let EQ1 = ""
let EQ2 = ""
/** The imported unit's consoles (fixture.template.json) and the host names of the 4 fake consoles. */
const K0 = "UART0"
const K1 = "UART1"
let HOSTS = []
let EFF = {}

const say = (s) => process.stdout.write(`${s}\n`)

async function shot(page, name) {
  shotN++
  const file = path.join(SHOTS, `${String(shotN).padStart(2, "0")}-${name}.png`)
  await page.screenshot({ path: file }).catch(() => {})
  return path.relative(REPO, file)
}

async function step(id, title, fn) {
  const s0 = Date.now()
  say(`\u001b[1;34m==>\u001b[0m ${id}. ${title}`)
  try {
    const detail = await fn()
    const ms = Date.now() - s0
    results.push({ id, title, ok: true, ms, detail: detail ?? null })
    say(`    [ OK ] ${detail ? `${detail} ` : ""}(${(ms / 1000).toFixed(1)} s)`)
  } catch (err) {
    results.push({ id, title, ok: false, ms: Date.now() - s0, error: String(err?.stack ?? err) })
    say(`    [FALLO] ${err instanceof StepError ? err.message : (err?.stack ?? err)}`)
    for (const p of ctx.pages) await shot(p.page, `fallo-${id}-${p.name}`)
    throw err
  }
}

function writeResults(ok) {
  fs.mkdirSync(SHOTS, { recursive: true })
  fs.writeFileSync(path.join(SHOTS, "results.json"), JSON.stringify({ ok, seconds: Math.round((Date.now() - t0) / 1000), port: PORT, steps: results }, null, 2))
}

async function cleanup() {
  for (const s of ctx.sockets) await s.close().catch(() => {})
  if (ctx.sse) await ctx.sse.close().catch(() => {})
  if (ctx.browser) await ctx.browser.close().catch(() => {})
  if (ctx.server) await ctx.server.stop().catch(() => {})
  if (ctx.echo) ctx.echo.close()
  if (ctx.sw) await ctx.sw.close().catch(() => {})
  if (ctx.ssh) await ctx.ssh.close().catch(() => {})
  await stopFakeBench(ctx.bench).catch(() => {})
  if (ctx.tmp && !KEEP) fs.rmSync(ctx.tmp, { recursive: true, force: true })
  else if (ctx.tmp) say(`    (--keep) datos de la prueba en ${ctx.tmp}`)
}

// ---------------------------------------------------------------------------------------------------------------
// Browser helpers

/** Optional Firefox for the CSP/WebSocket check (§2.8): RM_E2E_FIREFOX, or a Playwright build in ~/.cache. */
function firefoxPath() {
  if (process.env.RM_E2E_FIREFOX) return fs.existsSync(process.env.RM_E2E_FIREFOX) ? process.env.RM_E2E_FIREFOX : null
  const root = path.join(process.env.HOME ?? "", ".cache", "ms-playwright")
  const builds = fs.existsSync(root) ? fs.readdirSync(root).filter((d) => /^firefox-\d+$/.test(d)).sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1])) : []
  for (const b of builds) {
    const exe = path.join(root, b, "firefox", "firefox")
    if (fs.existsSync(exe)) return exe
  }
  return null
}

function chromePath() {
  const candidates = [process.env.RM_E2E_CHROME, "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].filter(Boolean)
  const found = candidates.find((p) => fs.existsSync(p))
  if (!found) throw new StepError(`No se encuentra Chrome (RM_E2E_CHROME, ${candidates.join(", ")})`)
  return found
}

/** A new browser context + page. `sr` turns on the terminal screen-reader mode so terminal text is in the DOM. */
async function newPage(name, { width = 1440, height = 900 } = {}) {
  const context = await ctx.browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 })
  await context.addInitScript(() => { try { localStorage.setItem("rm-term-sr", "1") } catch { /* private mode */ } })
  const page = await context.newPage()
  const errors = []
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`))
  // The workspace's "leave page?" guard (beforeunload) can fire while the app itself navigates (to /login when the
  // user is disabled): accept it here, so Playwright's own auto-dismiss cannot throw "Not attached to an active page".
  page.on("dialog", (d) => { void d.accept().catch(() => {}) })
  page.on("console", (m) => {
    if (m.type() !== "error") return
    const tx = m.text()
    // Expected noise: aborted streams on navigation and the 403/401 a test provokes on purpose.
    if (/net::ERR_ABORTED|Failed to load resource/.test(tx)) return
    errors.push(`console: ${tx.slice(0, 300)}`)
  })
  const entry = { name, context, page, errors }
  ctx.pages.push(entry)
  return entry
}

async function uiLogin(page, username, password) {
  await page.goto(`${BASE}/login`)
  if (!new URL(page.url()).pathname.startsWith("/login")) return // the session cookie is still valid
  await page.locator("input[name=username]").fill(username)
  await page.locator("input[name=password]").fill(password)
  await page.locator("button[type=submit]").click()
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20_000 })
}

const main = (page) => page.getByRole("main")
const dialogWith = (page, text) => page.locator("[role=dialog], [role=alertdialog]").filter({ hasText: text })
const pane = (page, key) => main(page).getByRole("region", { name: `${key} · ${key}` })
const termText = (page, key) => pane(page, key).locator(".xterm-accessibility-tree").innerText().catch(() => "")

async function waitTerm(page, key, re, what, timeout = 15_000) {
  return waitFor(async () => re.test(await termText(page, key)), { timeout, what: `${what} en el terminal ${key}` })
}

async function typeInTerminal(page, key, text, enter = false) {
  await pane(page, key).locator(".xterm-helper-textarea").focus()
  if (text) await page.keyboard.type(text, { delay: 20 })
  if (enter) await page.keyboard.press("Enter")
}

async function paneStatus(page, key) {
  return (await pane(page, key).getByRole("toolbar").innerText().catch(() => "")).replace(/\s+/g, " ")
}

// ---------------------------------------------------------------------------------------------------------------
// DB helpers (read-only, through the repo's better-sqlite3)

async function dbQuery(sql, ...params) {
  const { default: Database } = await import("better-sqlite3")
  const db = new Database(path.join(ctx.tmp, "data", "relay-manager.db"), { readonly: true, fileMustExist: true })
  try {
    return db.prepare(sql).all(...params)
  } finally {
    db.close()
  }
}

// ---------------------------------------------------------------------------------------------------------------
// TCP helpers for the accesses

/** Connects, optionally writes, collects what arrives for `ms`, then closes. Rejects when the port refuses. */
function tcpTalk(port, { send = null, ms = 600, until = null } = {}) {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host: "127.0.0.1", port })
    let buf = ""
    let done = false
    const finish = () => { if (done) return; done = true; s.destroy(); resolve(buf) }
    s.on("data", (d) => {
      buf += d.toString("utf8")
      if (until && until.test(buf)) finish()
    })
    s.once("connect", () => { if (send) setTimeout(() => s.write(send), 300) })
    s.once("error", (e) => { if (!done) { done = true; reject(e) } })
    setTimeout(finish, ms)
  })
}
const tcpRefused = (port) => tcpTalk(port, { ms: 300 }).then(() => false, () => true)

// ---------------------------------------------------------------------------------------------------------------

async function run() {
  fs.rmSync(SHOTS, { recursive: true, force: true })
  fs.mkdirSync(SHOTS, { recursive: true })

  await step("0", "Requisitos: compilación, Chrome, python3 y puertos libres", async () => {
    const chrome = chromePath()
    const py = spawnSync("python3", ["--version"], { encoding: "utf8" })
    if (py.status !== 0) throw new StepError("python3 es necesario para las consolas simuladas (scripts/sim/fake-zynq.py)")
    if (!fs.existsSync(path.join(REPO, "build", "server.js")) || !fs.existsSync(path.join(REPO, ".next", "BUILD_ID"))) {
      say("    build/server.js no existe: pnpm build")
      const b = spawnSync("pnpm", ["build"], { cwd: REPO, stdio: "inherit", env: { ...process.env, RM_DEV: "" } })
      if (b.status !== 0) throw new StepError("pnpm build ha fallado")
    }
    const rangeFree = async (base) => {
      for (let p = base; p < base + 30; p++) if (!(await portIsFree(p, "127.0.0.1"))) return false
      return true
    }
    let tries = 0
    while (!(await rangeFree(ACCESS_BASE))) {
      if (++tries >= 20) throw new StepError(`No hay 30 puertos libres seguidos para los accesos de la prueba (último intento: ${ACCESS_BASE})`)
      ACCESS_BASE = randomPort(21_000, 8_000)
    }
    for (const [host, port] of [["127.0.0.1", PORT], [RELAY_HOST, ASCII_PORT], [RELAY_HOST, HTTP_PORT]]) {
      if (!(await portIsFree(port, host))) throw new StepError(`El puerto ${host}:${port} está ocupado (¿otra prueba o un banco simulado en marcha?)`)
    }
    PROFILE = loadProfile(PROFILE_DIR)
    assert(PROFILE.templates.length > 0, `El perfil ${PROFILE.dir} no tiene plantillas (plantillas/*.json)`)
    TPL = pickWizardTemplate(PROFILE)
    C0 = TPL.consoles[0].key
    C1 = TPL.consoles[1].key
    ACC = TPL.accesses
    EQ1 = equipmentName(TPL.namePattern ?? "{template} #{nn}", TPL.name, 1)
    EQ2 = equipmentName(TPL.namePattern ?? "{template} #{nn}", TPL.name, 2)
    HOSTS = [`equipo-a-01-${hostPart(K0)}`, `equipo-a-01-${hostPart(K1)}`, `equipo-a-02-${hostPart(C0)}`, `equipo-a-02-${hostPart(C1)}`]
    for (const [i, c] of TPL.consoles.entries()) {
      const re = c.identify?.hostnameRegex
      if (re && !new RegExp(re, "i").test(HOSTS[2 + i])) say(`    Aviso: ${TPL.file}: hostnameRegex /${re}/ de ${c.key} no reconoce ${HOSTS[2 + i]} («Identificar» no lo asignará)`)
    }
    ctx.tmp = makeTempDir()
    fs.mkdirSync(path.join(ctx.tmp, "data"), { recursive: true, mode: 0o750 })
    ctx.browser = await chromium.launch({ executablePath: chrome, headless: !HEADED })
    return `${chrome} ${ctx.browser.version()}, ${py.stdout.trim()}, datos en ${ctx.tmp}; perfil ${PROFILE.dir} (${PROFILE.templates.length} plantillas; asistente: «${TPL.name}» de ${TPL.file})`
  })

  const dataDir = path.join(ctx.tmp, "data")
  const simDir = path.join(dataDir, "sim")
  let env

  await step("1", "Banco simulado: 4 consolas Zynq y un dS378 (ASCII + UDP)", async () => {
    ctx.bench = await startFakeBench({ dir: ctx.tmp, simDir, relayHost: RELAY_HOST, asciiPort: ASCII_PORT, httpPort: HTTP_PORT, udpPort: UDP_PORT, hosts: HOSTS })
    // The server never changes this machine's network in the test (RM_NET_HOST=off): it only lists the commands.
    ctx.sw = await createFakeSwitch({ host: "127.0.0.1", links: [1, 4] })
    // «Enviar a equipo»: the Ethernet of the imported unit (plain IP:port) is an SSH server with SFTP, root/root.
    ctx.ssh = await createFakeSshServer({ host: "127.0.0.1", home: path.join(ctx.tmp, "equipo-ssh") })
    plugAdapter(path.join(ctx.tmp, "net-sys"), { ifname: "enxe2e0", mac: NET_MAC })
    // The server reads a copy of the profile (step 5b adds and removes a template file to test «Recargar plantillas»).
    ctx.profileDir = path.join(ctx.tmp, "perfil")
    fs.cpSync(PROFILE.dir, ctx.profileDir, { recursive: true })
    env = serverEnv({
      dataDir,
      port: PORT,
      profile: { ...PROFILE, dir: ctx.profileDir },
      extra: {
        ...ctx.bench.env,
        RM_RELAY_SIMULATE: "0",
        RM_RELAY_DISCOVERY_PORT: String(UDP_PORT),
        RM_SETUP_TOKEN: TOKEN,
        RM_ACCESS_PORTS: `${ACCESS_BASE}-${ACCESS_BASE + 29}`,
        RM_ACCESS_BIND: "127.0.0.1",
        RM_JTAG_SYS_ROOT: path.join(ctx.tmp, "jtag-sys"),
        RM_HW_SERVER: FAKE_HW_SERVER,
        RM_NET_SYS_ROOT: path.join(ctx.tmp, "net-sys"),
        RM_NET_HOST: "off",
        RM_NET_SWITCH_HTTP_PORT: String(ctx.sw.port),
        RM_NET_POLL_MS: "2000",
      },
    })
    // Effective values (environment > perfil.env > generic defaults), what the UI must show.
    const v = (k) => env[k] ?? PROFILE.env[k]
    EFF = {
      extraName: v("RM_FILES_EXTRA_NAME"),
      extraDir: env.RM_FILES_EXTRA_DIR,
      downloader: v("RM_EXPORT_DOWNLOADER"),
      fakeDownloader: v("RM_EXPORT_DOWNLOADER") === FAKE_DOWNLOADER,
      exportRoot: v("RM_EXPORT_ROOT") || "extra",
      exportTitle: v("RM_EXPORT_TITLE") || "Ejecutar script de descarga…",
      appLabel: v("RM_EXPORT_APP_LABEL") || "Aplicación",
      versionLabel: v("RM_EXPORT_VERSION_LABEL") || "Versión",
      extractLabel: v("RM_EXPORT_EXTRACT_LABEL") || null,
      equipIp: v("RM_EQUIPNET_EQUIPMENT_IP"),
      equipPort: v("RM_EQUIPNET_EQUIPMENT_PORT") || "22",
    }
    fs.mkdirSync(EFF.extraDir, { recursive: true })
    const own = Object.keys(env).filter((k) => /^RM_(FILES_EXTRA_NAME|EXPORT_ENABLED|EXPORT_DOWNLOADER|EQUIPNET_EQUIPMENT_IP)$/.test(k))
    return `${ctx.bench.links.map((l) => path.basename(l)).join(", ")} y dS378 en ${RELAY_HOST}:${ASCII_PORT}; segunda carpeta «${EFF.extraName}», script ${path.isAbsolute(EFF.downloader) ? path.relative(REPO, EFF.downloader) : EFF.downloader}${own.length ? `; además del perfil: ${own.join(", ")}` : ""}`
  })

  await step("2", "Servidor: primer arranque (configuración pendiente)", async () => {
    ctx.server = await startServer({ env, logFile: path.join(ctx.tmp, "server.log") })
    const health = await (await fetch(`${BASE}/api/health`)).json()
    assert(JSON.stringify(Object.keys(health).sort()) === JSON.stringify(["ok", "version"]), `/api/health devuelve más que {ok, version}: ${JSON.stringify(health)}`)
    assert(ctx.server.log().includes(TOKEN), "el código de configuración no aparece en el registro")
    return `/api/health ${JSON.stringify(health)}`
  })

  const admin = await newPage("admin")
  const A = admin.page

  await step("3", "Configuración inicial en el navegador con el código", async () => {
    await A.goto(`${BASE}/`)
    await A.waitForURL(/\/setup$/, { timeout: 20_000 })
    await A.locator("input[name=token]").fill(TOKEN)
    await A.locator("input[name=username]").fill(ADMIN.username)
    await A.locator("input[name=name]").fill(ADMIN.name)
    await A.locator("input[name=password]").fill(ADMIN.password)
    await A.locator("input[name=passwordConfirm]").fill(ADMIN.password)
    await shot(A, "setup")
    await A.locator("button[type=submit]").click()
    await A.waitForURL((u) => u.pathname === "/", { timeout: 30_000 })
    await main(A).getByRole("heading", { name: "Banco", level: 1 }).waitFor()
    await main(A).getByText("Aún no hay equipos").waitFor()
    await shot(A, "banco-vacio")
    assert(!fs.existsSync(path.join(dataDir, "setup-token")), "el fichero setup-token sigue existiendo tras la configuración")
    return "administrador creado; Banco vacío"
  })

  await step("3b", "Sin placas ni equipos: todas las pantallas se muestran sin errores", async () => {
    const pages = ["/", "/archivos", "/descubrimiento", "/descubrimiento?tab=jtag", "/cables", "/placas", "/plantillas", "/equipos/nuevo", "/auditoria", "/usuarios", "/roles",
      "/sistema", "/sistema/salud", "/sistema/consolas", "/sistema/copias", "/sistema/reservas", "/sistema/accesos", "/sistema/red-equipos", "/descubrimiento?tab=red", "/cables?tab=red", "/sistema/acerca", "/cuenta"]
    const seen = []
    for (const p of pages) {
      const res = await A.goto(`${BASE}${p}`)
      assert(res && res.status() === 200, `${p}: HTTP ${res?.status()}`)
      await main(A).getByRole("heading", { level: 1 }).first().waitFor()
      const h1 = (await main(A).getByRole("heading", { level: 1 }).first().innerText()).trim()
      assert(!/No se ha podido|Algo ha fallado|Error/i.test(h1), `${p}: página de error «${h1}»`)
      seen.push(`${p} «${h1}»`)
    }
    // The profile's templates, loaded at start: read-only («Fichero»), with «Recargar plantillas».
    await A.goto(`${BASE}/plantillas`)
    for (const t of PROFILE.templates) {
      const row = main(A).getByRole("row").filter({ hasText: t.name }).first()
      await row.waitFor({ timeout: 10_000 })
      assert(/Fichero/.test(await row.innerText()), `la plantilla «${t.name}» (${t.file}) no muestra «Fichero»`)
    }
    await main(A).getByRole("button", { name: "Recargar plantillas" }).waitFor()
    await shot(A, "plantillas-del-perfil")
    await A.goto(`${BASE}/placas`)
    await shot(A, "placas-vacio")
    await A.goto(`${BASE}/equipos/nuevo`)
    await shot(A, "asistente-sin-placas")
    const errs = admin.errors.length
    assert(!errs, `errores del navegador: ${admin.errors.join(" | ")}`)
    return seen.join(", ")
  })

  await step("4", "Datos de la prueba: parada, config import, usuario operador y nuevo arranque", async () => {
    const stopped = await ctx.server.stop()
    assert(stopped.code === 0 && stopped.ms < 8000, `SIGTERM: salida ${JSON.stringify(stopped)}`)
    const jsonText = (t) => JSON.stringify(t).slice(1, -1)
    const rendered = JSON.parse(fs.readFileSync(path.join(REPO, "scripts", "e2e", "fixture.template.json"), "utf8")
      .replaceAll("${SIM_DIR}", simDir).replaceAll("${EQ1_NAME}", jsonText(EQ1)).replaceAll("${TPL_NAME}", jsonText(TPL.name)))
    // The imported unit's Ethernet: the fake SSH server of this run (the last port of the access range).
    rendered.equipment[0].accesses = [{
      key: "ETH", label: "Ethernet", kind: "tcp", port: ACCESS_BASE + 29, enabled: true, policy: "reserved", cableSerial: null, consoleKey: null,
      targetHost: "127.0.0.1", targetPort: ctx.ssh.port, targetMode: "ip", switchPort: null, sshUser: "root",
    }]
    const fixture = path.join(ctx.tmp, "fixture.json")
    fs.writeFileSync(fixture, JSON.stringify(rendered, null, 2))
    const dry = await cli(["config", "import", fixture, "--dry-run"], env)
    assert(dry.code === 0, `config import --dry-run: ${dry.stderr || dry.stdout}`)
    const imp = await cli(["config", "import", fixture], env)
    assert(imp.code === 0, `config import: ${imp.stderr || imp.stdout}`)
    const chk = await cli(["plantillas", "comprobar"], env)
    assert(chk.code === 0, `plantillas comprobar: ${chk.stderr || chk.stdout}`)
    const user = await cli(["user", "create", OPER.username, "--name", OPER.name, "--password-stdin"], env, `${OPER.firstPassword}\n`)
    assert(user.code === 0, `user create: ${user.stderr || user.stdout}`)
    ctx.server = await startServer({ env, logFile: path.join(ctx.tmp, "server.log") })
    await waitFor(() => /Consola abierta consola=UART1/.test(ctx.server.log()), { timeout: 10_000, what: "que el servidor abra UART1" })
    return `SIGTERM en ${stopped.ms} ms; ${imp.stdout.trim()}; plantillas comprobar: 0`
  })

  // IDs of the imported unit.
  const [eq1] = await dbQuery("SELECT id FROM Equipment WHERE name = ?", EQ1)
  const consoles1 = Object.fromEntries((await dbQuery("SELECT id, key FROM SerialConsole WHERE equipmentId = ?", eq1.id)).map((c) => [c.key, c.id]))
  const api = new HttpSession(BASE)

  await step("4b", "Reconexión USB simulada de UART0: se reabre sola en menos de 3 s", async () => {
    const opens = () => ctx.server.log().split("\n").filter((l) => l.includes("Consola abierta consola=UART0")).length
    const before = opens()
    const r = await replugConsole(ctx.bench, "ttyV0")
    const t = Date.now()
    await waitFor(() => opens() > before && fdsPointingAt(ctx.server.pid, r.newTarget).length > 0, { timeout: 3000, interval: 100, what: `que el servidor reabra ${r.newTarget}` })
    return `${r.oldTarget} → ${r.newTarget} (pty nuevo), reabierto en ${Date.now() - t} ms`
  })

  await step("4c", "Sesión HTTP de administración, SSE y comprobaciones de WebSocket", async () => {
    const login = await api.login(ADMIN.username, ADMIN.password)
    assert(login.ok, `login por credenciales: HTTP ${login.status}`)
    const noOrigin = await api.post("/api/auth/signout", new URLSearchParams({ csrfToken: "x" }), { origin: null })
    assert(noOrigin.status === 403, `POST sin Origin → ${noOrigin.status} (se esperaba 403)`)
    ctx.sse = await openSse(api)
    const hello = await ctx.sse.waitFor((e) => e.type === "hello", "hello")
    assert(hello.data?.serverNow, "hello sin serverNow")
    const bad = openConsoleWs(api, consoles1.UART0, { origin: "http://evil.example" })
    await bad.waitClosed()
    assert(bad.state.httpStatus === 403, `WS con Origin ajeno → ${bad.state.httpStatus ?? bad.state.closeCode}`)
    const anon = openConsoleWs(new HttpSession(BASE), consoles1.UART0)
    await anon.waitClosed()
    assert(anon.state.closeCode === 4001, `WS sin sesión → ${anon.state.closeCode ?? anon.state.httpStatus}`)
    const unknown = openConsoleWs(api, "cnotarealconsole000000000")
    await unknown.waitClosed()
    assert(unknown.state.closeCode === 4004, `WS de una consola inexistente → ${unknown.state.closeCode ?? unknown.state.httpStatus}`)
    const ws = openConsoleWs(api, consoles1.UART0)
    ctx.sockets.push(ws)
    const h = await ws.waitMsg((m) => m.t === "hello", "hello")
    await ws.waitMsg((m) => m.t === "history-end", "history-end")
    assert(h.mode === "ro", `modo inicial ${h.mode}`)
    await ws.waitText(/login:/, "«login:» (arranque tras la reconexión)", 20_000)
    ctx.secIfWs = ws
    return `SSE hello ${hello.data.serverNow}; WS: Origin ajeno 403, sin sesión 4001, desconocida 4004, hello ro + historial`
  })

  await step("5", "Banco con el equipo importado", async () => {
    await uiLogin(A, ADMIN.username, ADMIN.password)
    await A.goto(`${BASE}/`)
    const card = main(A).getByRole("article", { name: EQ1 })
    await card.waitFor()
    const consoles = card.getByRole("list", { name: "Consolas" })
    await waitFor(async () => (await consoles.getByRole("listitem").count()) === 2, { what: "2 consolas en la tarjeta" })
    const text = (await consoles.innerText()).replace(/\s+/g, " ")
    assert(/UART0/.test(text) && /UART1/.test(text) && /(Recibiendo|Sin datos)/.test(text), `estado de las consolas: ${text}`)
    const relays = (await card.getByRole("list", { name: "Estado de los relés (solo lectura)" }).innerText()).replace(/\s+/g, " ")
    assert(/Alimentación/.test(relays) && /Reset/.test(relays), `relés de la tarjeta: ${relays}`)
    await shot(A, "banco")
    const res = await fetch(`${BASE}/login`)
    const csp = res.headers.get("content-security-policy") ?? ""
    assert(/connect-src 'self'/.test(csp) && /object-src 'none'/.test(csp), `CSP de producción: ${csp}`)
    const icon = await fetch(`${BASE}/icon.svg`)
    assert(icon.status === 200 && /svg/.test(icon.headers.get("content-type") ?? ""), `/icon.svg: ${icon.status} ${icon.headers.get("content-type")}`)
    assert((await A.locator('head link[rel=icon][href^="/icon.svg"]').count()) === 1, "falta <link rel=icon> a /icon.svg")
    return `consolas: ${text}; relés: ${relays}; CSP con connect-src 'self'`
  })

  await step("5a", "Cables: conectar un cable JTAG simulado y etiquetarlo como JTAG-01", async () => {
    const jtagRoot = path.join(ctx.tmp, "jtag-sys")
    await A.goto(`${BASE}/cables`)
    await main(A).getByRole("heading", { name: "Cables", level: 1 }).waitFor()
    await main(A).getByRole("button", { name: "Etiquetar un cable" }).click()
    const dlg = dialogWith(A, "Etiquetar un cable")
    await dlg.getByText("Conecta el cable que quieres etiquetar…").waitFor()
    await shot(A, "cables-esperando")
    plugCable(jtagRoot, { serial: JTAG_SERIAL, port: "7" })
    const name = dlg.getByRole("textbox", { name: "Nombre" })
    await name.waitFor({ timeout: 15_000 })
    assert((await name.inputValue()) === "JTAG-01", `nombre sugerido: ${await name.inputValue()}`)
    assert(/210299E2E001/.test(await dlg.innerText()), "el diálogo no muestra el número de serie del cable detectado")
    await shot(A, "cables-nombre")
    await dlg.getByRole("button", { name: "Guardar etiqueta" }).click()
    await dlg.getByText("Etiquetado como JTAG-01").waitFor()
    await dlg.getByRole("button", { name: "Listo" }).click()
    const row = main(A).getByRole("row").filter({ hasText: "JTAG-01" })
    await row.waitFor()
    const text = (await row.innerText()).replace(/\s+/g, " ")
    assert(/210299E2E001/.test(text) && /Conectado/.test(text), `fila de JTAG-01: ${text}`)
    await shot(A, "cables")
    const [label] = await dbQuery("SELECT name, identity FROM CableLabel WHERE kind = 'jtag'")
    assert(label?.identity === JTAG_SERIAL, `etiqueta en la base de datos: ${JSON.stringify(label)}`)
    await A.goto(`${BASE}/`)
    return `${JTAG_SERIAL} → JTAG-01 (detectado al conectarlo)`
  })

  await step("5a2", "Red de equipos: se elige la interfaz del switch, se busca el TL-SG108E simulado y se prepara", async () => {
    // Descubrimiento › Adaptadores de red lists the USB adapter.
    await A.goto(`${BASE}/descubrimiento?tab=red`)
    const adapter = main(A).locator("[data-adapter=enxe2e0]")
    await adapter.waitFor()
    assert(/AX88179A/.test(await adapter.innerText()), `adaptador: ${await adapter.innerText()}`)
    // Banco: only a passive card with a link (nothing is searched nor changed until an interface is chosen).
    await A.goto(`${BASE}/`)
    await main(A).getByText("Hay adaptadores de red sin configurar").waitFor({ timeout: 15_000 })
    await shot(A, "banco-red-sin-configurar")
    assert(ctx.sw.log.length === 0, `el switch ha recibido peticiones antes de elegir la interfaz: ${ctx.sw.log.length}`)
    await main(A).getByRole("link", { name: "Configurar red de equipos" }).click()
    await A.waitForURL(/\/sistema\/red-equipos/)
    await main(A).getByTestId("equipnet-view").waitFor()
    // Step 1: every interface of the server in a table; «Usar esta» on the USB adapter, with what will happen.
    const ifRow = main(A).getByTestId("equipnet-interfaces").locator("[data-iface=enxe2e0]")
    await ifRow.waitFor()
    await shot(A, "red-equipos-interfaces")
    await ifRow.getByRole("button", { name: "Usar esta: enxe2e0" }).click()
    const choose = A.getByTestId("choose-interface-dialog")
    await choose.getByText("No se toca ninguna otra interfaz, ni la ruta por defecto, ni la tabla de rutas principal.").waitFor()
    assert(/Se añade 192\.168\.0\.250\/24 a enxe2e0/.test(await choose.innerText()), `diálogo de elección: ${await choose.innerText()}`)
    await choose.getByRole("button", { name: "Usar esta interfaz" }).click()
    await choose.waitFor({ state: "detached" })
    await ifRow.getByText("En uso").waitFor()
    // Step 2: the automatic search only goes out from the interface's own address, which a fake adapter cannot have
    // (RM_NET_HOST=off): the switch IP is typed instead.
    const find = main(A).getByTestId("equipnet-find")
    await find.getByRole("textbox", { name: "O escribe la IP del switch" }).fill("127.0.0.1")
    await find.getByRole("button", { name: "Probar esta IP" }).click()
    await A.getByText("Switch encontrado en 127.0.0.1").first().waitFor({ timeout: 20_000 })
    await main(A).getByTestId("equipnet-found").getByText("Switch TL-SG108E en 127.0.0.1").waitFor()
    await shot(A, "red-equipos-buscar")
    // Step 3: one dialog, the plan in plain words, «Detalles», one button.
    await main(A).getByRole("button", { name: "Preparar el switch…" }).click()
    const dlg = A.getByTestId("prepare-switch-dialog")
    await dlg.getByText("Puertos 2 a 8: un equipo cada uno, aislados entre sí.").waitFor()
    assert((await dlg.getByLabel("Contraseña del switch").inputValue()) === "admin", "la contraseña de fábrica no viene rellenada")
    await dlg.getByRole("button", { name: "Detalles" }).click()
    await dlg.getByText(/Activar la VLAN 802\.1Q/).waitFor({ timeout: 20_000 })
    assert(/Este servidor está conectado al puerto 1 del switch/.test(await dlg.innerText()), "no se comprueba el puerto del servidor")
    await shot(A, "preparar-switch-detalles")
    assert(!ctx.sw.state().dot1q.enabled, "la vista previa ha cambiado el switch")
    await dlg.getByRole("button", { name: "Preparar switch" }).click()
    await dlg.getByText("Switch preparado: cada puerto lleva a su equipo.").waitFor({ timeout: 30_000 })
    await shot(A, "preparar-switch-hecho")
    await dlg.getByRole("button", { name: "Listo" }).click()
    const st = ctx.sw.state()
    assert(JSON.stringify(st.dot1q.pvids) === JSON.stringify([1, 102, 103, 104, 105, 106, 107, 108]) && st.saves === 1, `switch: ${JSON.stringify(st.dot1q)}`)
    assert(JSON.stringify(st.dot1q.vlans.find((v) => v.vid === 1)?.untagged) === "[1]", "la VLAN 1 no se ha quedado solo con el puerto 1")
    const [row] = await dbQuery("SELECT enabled, adapterMac, switchHost, switchPassword FROM EquipmentNetwork")
    assert(row.enabled === 1 && row.adapterMac === NET_MAC && row.switchHost === "127.0.0.1" && /^v1:/.test(row.switchPassword), `ajustes: ${JSON.stringify({ ...row, switchPassword: "…" })}`)
    const [label] = await dbQuery("SELECT name FROM CableLabel WHERE kind = 'net-adapter'")
    assert(label?.name === "ETH-01", `etiqueta del adaptador: ${JSON.stringify(label)}`)
    // Sistema › Red de equipos: ports with link, and the server side pending (RM_NET_HOST=off) with its commands.
    await A.goto(`${BASE}/sistema/red-equipos`)
    const ports = main(A).getByTestId("switch-ports")
    await waitFor(async () => /Enlace activo/.test(await ports.locator("[data-port='4']").innerText()), { timeout: 15_000, what: "enlace del puerto 4" })
    const page = (await main(A).innerText()).replace(/\s+/g, " ")
    assert(/Sin permiso para cambiar la red/.test(page) && /ip link add link enxe2e0 name rmv102 type vlan id 102/.test(page), `estado del servidor: ${page.slice(0, 600)}`)
    await shot(A, "sistema-red-equipos")
    const acts = await dbQuery("SELECT action, outcome FROM AuditEvent WHERE action LIKE 'equipnet.%' ORDER BY id")
    assert(acts.some((a) => a.action === "equipnet.switch.apply" && a.outcome === "ok"), `auditoría: ${JSON.stringify(acts)}`)
    await A.goto(`${BASE}/`)
    return `switch con VLAN 102-108 y PVID por puerto, guardado; ${acts.length} filas de auditoría`
  })

  ctx.echo = net.createServer((c) => { c.on("error", () => {}); c.on("data", (d) => c.write(`eco:${d}`)) })
  const ECHO_PORT = await new Promise((resolve) => ctx.echo.listen(0, "127.0.0.1", () => resolve(ctx.echo.address().port)))

  let eq2Id = null
  await step("5b", "Asistente: equipo nuevo con la plantilla del perfil y AUX, «Asignar en orden», «Identificar»; la plantilla de fichero no se edita desde el asistente; Plantillas: «Recargar plantillas» y «Duplicar»", async () => {
    await main(A).getByRole("link", { name: "Nuevo equipo" }).click()
    await A.waitForURL(/\/equipos\/nuevo$/)
    const tpl = main(A).getByRole("radio", { name: new RegExp(`^${reEsc(TPL.name)}`) })
    await tpl.waitFor()
    if (TPL.needsReview) assert(/Revisar/.test(await tpl.innerText()), `la plantilla «${TPL.name}» no muestra el chip «Revisar»`)
    await tpl.click()
    await shot(A, "asistente-plantilla")
    await main(A).getByRole("button", { name: "Siguiente" }).click()
    await main(A).getByRole("button", { name: "Añadir consola" }).click()
    await main(A).getByRole("textbox", { name: "Clave 3" }).fill("AUX")
    await main(A).getByRole("textbox", { name: "Etiqueta 3" }).fill("AUX")
    await shot(A, "asistente-consolas")
    await main(A).getByRole("button", { name: "Siguiente" }).click()
    const group = main(A).getByRole("region", { name: "Puertos virtuales y del sistema" })
    await group.waitFor()
    await group.getByRole("button", { name: "Asignar en orden" }).click()
    const slots = main(A).getByRole("region", { name: "Consolas del equipo" })
    await waitFor(async () => {
      const s = (await slots.innerText()).replace(/\s+/g, " ")
      return new RegExp(`${reEsc(C0)}.*ttyV2`).test(s) && new RegExp(`${reEsc(C1)}.*ttyV3`).test(s) && /AUX.*Sin asignar/.test(s)
    }, { what: `${C0} → ttyV2, ${C1} → ttyV3 y AUX sin asignar` })
    await group.getByRole("button", { name: "Identificar" }).click()
    await waitFor(async () => /identificad/.test(await group.getByRole("status").innerText()), { timeout: 30_000, what: "el resultado de «Identificar»" })
    const chips = (await group.getByRole("listitem").filter({ hasText: "ttyV2" }).innerText()).replace(/\s+/g, " ")
    await shot(A, "asistente-conexiones")
    await main(A).getByRole("button", { name: "Siguiente" }).click()
    // Accesos: the template's 5; the first JTAG gets the labelled cable, the Ethernet the local echo server.
    await main(A).getByRole("combobox", { name: "Cable 1" }).click()
    await A.getByRole("option", { name: /JTAG-01/ }).click()
    // Ethernet of the template: "a port of the switch"; this one goes to the local echo server instead ("Sin switch").
    await main(A).getByRole("combobox", { name: "Puerto del switch 5" }).click()
    const opts = (await A.getByRole("option").allInnerTexts()).join(" | ").replace(/\s+/g, " ")
    assert(/Puerto 4 del switch.*enlace activo.*libre/.test(opts), `puertos del switch en el asistente: ${opts}`)
    await A.getByRole("option", { name: "Sin switch: dirección IP" }).click()
    await main(A).getByRole("textbox", { name: "IP del equipo 5" }).fill("127.0.0.1")
    await main(A).getByRole("textbox", { name: "Puerto del equipo 5" }).fill(String(ECHO_PORT))
    // A second Ethernet on the switch: something is plugged into port 5 now → the wizard suggests it.
    await main(A).getByRole("button", { name: "Añadir Ethernet" }).click()
    await fetch(`http://127.0.0.1:${ctx.sw.port}/__sim/link?port=5&up=1`)
    await main(A).getByText("Acabas de conectar algo al puerto 5.").waitFor({ timeout: 15_000 })
    await main(A).getByRole("button", { name: "Usar el puerto 5" }).click()
    const accText = (await main(A).locator("[data-access-row]").allInnerTexts()).length
    assert(accText === 6, `filas de accesos en el asistente: ${accText}`)
    await shot(A, "asistente-accesos")
    await main(A).getByRole("button", { name: "Siguiente" }).click()
    const name = main(A).getByRole("textbox", { name: "Nombre" })
    await name.waitFor()
    assert((await name.inputValue()) === EQ2, `nombre sugerido: ${await name.inputValue()} (se esperaba ${EQ2})`)
    await shot(A, "asistente-nombre")
    await main(A).getByRole("button", { name: "Siguiente" }).click()
    // A template from the profile's files is read-only: no «Guardar … en la plantilla» here.
    await main(A).getByRole("button", { name: "Crear equipo" }).waitFor()
    assert((await main(A).getByRole("checkbox", { name: /en la plantilla/ }).count()) === 0, `el asistente ofrece guardar en la plantilla de fichero «${TPL.name}»`)
    await shot(A, "asistente-revision")
    await main(A).getByRole("button", { name: "Crear equipo" }).click()
    await A.waitForURL((u) => /^\/equipos\/[a-z0-9]+$/.test(u.pathname) && u.pathname !== "/equipos/nuevo", { timeout: 30_000 })
    eq2Id = A.url().split("/").pop()
    const panes = main(A).getByRole("region", { name: "Consolas del equipo" }).getByRole("toolbar")
    await waitFor(async () => (await panes.count()) === 3, { what: "3 paneles de consola" })
    assert((await main(A).getByRole("region", { name: /^Relés/ }).count()) === 0, "el equipo sin relés muestra la barra de relés")
    await main(A).getByRole("button", { name: "Reservar", exact: true }).first().click()
    await main(A).getByText(/^Tuyo/).first().waitFor()
    await shot(A, "equipo2-reservado")
    await main(A).getByRole("button", { name: "Liberar" }).first().click()
    await main(A).getByRole("button", { name: "Reservar", exact: true }).first().waitFor()
    // Plantillas: the file template, read-only; «Recargar plantillas» (audited) and «Duplicar» (an editable local copy).
    await A.goto(`${BASE}/plantillas`)
    const rowOf = (n) => main(A).getByRole("row").filter({ hasText: n })
    const row = rowOf(TPL.name).filter({ hasText: "Fichero" }).first()
    await row.waitFor()
    const rowText = (await row.innerText()).replace(/\s+/g, " ")
    await shot(A, "plantillas")
    // «Recargar plantillas»: nothing changed; a new file → a new read-only template (audited); its file removed → «Retirada».
    const reloadBtn = main(A).getByRole("button", { name: "Recargar plantillas" })
    await reloadBtn.click()
    await A.getByText("Las plantillas del perfil ya estaban al día").first().waitFor()
    const extraTpl = { ...Object.fromEntries(Object.entries(TPL).filter(([k]) => k !== "file")), key: "e2e-recarga", name: "Plantilla E2E recargada", position: 99 }
    const extraFile = path.join(ctx.profileDir, "plantillas", "e2e-recarga.json")
    fs.writeFileSync(extraFile, JSON.stringify(extraTpl, null, 2))
    await reloadBtn.click()
    await A.getByText("1 plantilla actualizada desde el perfil").first().waitFor()
    await rowOf("Plantilla E2E recargada").filter({ hasText: "Fichero" }).first().waitFor()
    await waitFor(async () => (await dbQuery("SELECT count(*) AS n FROM AuditEvent WHERE action = 'template.reload'"))[0].n >= 1, { what: "template.reload en la auditoría" })
    fs.rmSync(extraFile)
    await reloadBtn.click()
    await rowOf("Plantilla E2E recargada").filter({ hasText: "Retirada" }).first().waitFor({ timeout: 10_000 })
    await shot(A, "plantillas-recargadas")
    await row.getByRole("link", { name: TPL.name }).first().click()
    await main(A).getByText(`Definida en ${TPL.file}`, { exact: false }).first().waitFor()
    await shot(A, "plantilla-de-fichero")
    const before = (await dbQuery("SELECT count(*) AS n FROM EquipmentTemplate WHERE source = 'local'"))[0].n
    await main(A).getByRole("button", { name: "Duplicar…" }).click()
    const dup = A.getByRole("dialog").filter({ hasText: "Duplicar plantilla" })
    await dup.waitFor()
    assert((await dup.getByLabel("Nombre de la copia").inputValue()) === `${TPL.name} (copia)`, "nombre propuesto para la copia")
    await dup.getByRole("button", { name: "Duplicar", exact: true }).click()
    await waitFor(async () => (await dbQuery("SELECT count(*) AS n FROM EquipmentTemplate WHERE source = 'local'"))[0].n === before + 1, { timeout: 15_000, what: "la copia local de la plantilla" })
    const [copy] = await dbQuery("SELECT name, key, source, sourceFile FROM EquipmentTemplate WHERE source = 'local' ORDER BY createdAt DESC LIMIT 1")
    assert(copy && copy.key === null && copy.sourceFile === null, `copia de la plantilla: ${JSON.stringify(copy)}`)
    await A.goto(`${BASE}/plantillas`)
    const copyRow = rowOf(copy.name).filter({ hasNotText: "Fichero" }).first()
    await copyRow.waitFor()
    await shot(A, "plantillas-duplicada")
    return `${chips}; plantilla de fichero: ${rowText}; recargar: al día, fichero nuevo → creada, fichero borrado → «Retirada»; duplicada como «${copy.name}» (local)`
  })

  await step("5c", "Equipo sin relés en el Banco: reservar y liberar desde la tarjeta", async () => {
    await A.goto(`${BASE}/`)
    const card = main(A).getByRole("article", { name: EQ2 })
    await card.waitFor()
    const href = await card.getByRole("link", { name: EQ2, exact: true }).getAttribute("href")
    assert(href === `/equipos/${eq2Id}`, `la tarjeta de ${EQ2} enlaza con ${href}, no con /equipos/${eq2Id}`)
    assert((await card.getByRole("list", { name: "Estado de los relés (solo lectura)" }).count()) === 0, `la tarjeta de ${EQ2} muestra relés`)
    await card.getByRole("button", { name: `Reservar ${EQ2}` }).click()
    await card.getByText(/Tuyo/).first().waitFor()
    await shot(A, "banco-equipo2-reservado")
    await card.getByRole("button", { name: `Más acciones de ${EQ2}` }).click()
    await A.getByRole("menuitem", { name: "Liberar" }).click()
    await card.getByRole("button", { name: `Reservar ${EQ2}` }).waitFor()
    await card.getByText("Libre").first().waitFor()
    return "sin fila de relés; reserva y liberación desde la tarjeta"
  })

  await step("5f", "Accesos del equipo nuevo: cerrados sin reserva; al reservar, JTAG (hw_server con el filtro del cable), serie y Ethernet; al liberar, cerrados", async () => {
    const all = await dbQuery("SELECT key, port, kind, jtagCableSerial AS cable, targetPort, targetMode, switchPort FROM EquipmentAccess WHERE equipmentId = ? ORDER BY position", eq2Id)
    // The template's 5 accesses, then the added Ethernet (key and label as the wizard makes them: ETH, else ETH_<n>).
    const taken = new Set(ACC.map((x) => x.key))
    let n = taken.has("ETH") ? 2 : 1
    while (taken.has(`ETH_${n}`)) n++
    const addedEth = { key: `ETH_${n}`, label: `Ethernet ${n}` }
    const [JTAG0, JTAG1, SERIE0, , ETH] = ACC
    assert(JSON.stringify(all.map((r) => r.key)) === JSON.stringify([...ACC.map((x) => x.key), addedEth.key]), `accesos: ${JSON.stringify(all)}`)
    assert(all[4].targetMode === "ip" && all[5].targetMode === "switch" && all[5].switchPort === 5 && all[5].targetPort === Number(EFF.equipPort), `Ethernet: ${JSON.stringify(all.slice(4))}`)
    const rows = all.slice(0, 5)
    const ports = Object.fromEntries(rows.map((r) => [r.key, r.port]))
    assert(rows.every((r) => r.port >= ACCESS_BASE && r.port < ACCESS_BASE + 30), `puertos fuera del rango: ${JSON.stringify(rows)}`)
    assert(rows[0].cable === JTAG_SERIAL, `cable de ${JTAG0.key}: ${rows[0].cable}`)
    for (const p of Object.values(ports)) assert(await tcpRefused(p), `el puerto ${p} está abierto sin reserva`)
    await A.goto(`${BASE}/equipos/${eq2Id}/accesos`)
    await main(A).getByText("Reserva el equipo para abrir los accesos.").first().waitFor()
    await shot(A, "accesos-sin-reserva")
    await main(A).getByRole("button", { name: "Reservar", exact: true }).first().click()
    await main(A).getByText(/^Tuyo/).first().waitFor()
    const card = (label) => main(A).getByRole("listitem", { name: new RegExp(`^${reEsc(label)} ·`) })
    await waitFor(async () => /Abierto/.test(await card(JTAG0.label).innerText()), { timeout: 20_000, what: `${JTAG0.label} abierto` })
    await waitFor(async () => /Abierto/.test(await card(SERIE0.label).innerText()), { what: `${SERIE0.label} abierto` })
    await waitFor(async () => /Abierto/.test(await card(ETH.label).innerText()), { what: `${ETH.label} abierto` })
    assert(/Sin configurar/.test(await card(JTAG1.label).innerText()), `${JTAG1.label} sin cable debería estar «Sin configurar»`)
    // Through the switch: port 5, its link, the equipment IP; the server's VLAN is not there (RM_NET_HOST=off).
    const eth2 = (await card(addedEth.label).innerText()).replace(/\s+/g, " ")
    assert(/Sin red de equipos/.test(eth2) && /Puerto 5 del switch/.test(eth2) && /enlace activo/.test(eth2) && eth2.includes(`${EFF.equipIp}:${EFF.equipPort}`) && /ssh -p \d+ root@127\.0\.0\.1/.test(eth2), `tarjeta ${addedEth.label}: ${eth2}`)
    const jtagCard = (await card(JTAG0.label).innerText()).replace(/\s+/g, " ")
    assert(jtagCard.includes(`connect -host 127.0.0.1 -port ${ports[JTAG0.key]}`) && /JTAG-01/.test(jtagCard), `tarjeta ${JTAG0.label}: ${jtagCard}`)
    await shot(A, "accesos-abiertos")
    // JTAG: the fake hw_server answers with how it was started.
    const hw = await tcpTalk(ports[JTAG0.key], { until: /\n/ })
    assert(hw.trim() === `fake-hw_server port=${ports[JTAG0.key]} jtag-port-filter=${JTAG_SERIAL} gdb=0`, `hw_server: ${hw}`)
    // Serial: the notice, the console history, and a command answered by the fake shell (written while reserved).
    const serie = await tcpTalk(ports[SERIE0.key], { send: "tcp-e2e\r", until: /tcp-e2e: not found/, ms: 5000 })
    assert(serie.includes(`Relay Manager · ${EQ2} · ${C0} · escritura permitida`), `aviso de la consola por TCP: ${serie.slice(0, 200)}`)
    assert(/tcp-e2e: not found/.test(serie), `la consola no ha respondido por TCP: ${serie.slice(-200)}`)
    // Ethernet: forwarded to the local echo server.
    const eth = await tcpTalk(ports[ETH.key], { send: "hola", until: /eco:hola/ })
    assert(/eco:hola/.test(eth), `reenvío Ethernet: ${eth}`)
    await waitFor(async () => /Abierto/.test(await card(ETH.label).innerText()), { what: `${ETH.label} sigue abierto` })
    // Serial and Ethernet connections are audited at once (JTAG ones only when the 5 s kernel-table poll sees them).
    const opens = await dbQuery("SELECT count(*) AS n FROM AuditEvent WHERE action = 'access.connect'")
    assert(opens[0].n >= 2, `conexiones auditadas: ${opens[0].n}`)
    await main(A).getByRole("button", { name: "Liberar" }).first().click()
    await main(A).getByRole("button", { name: "Reservar", exact: true }).first().waitFor()
    for (const [k, p] of Object.entries(ports)) await waitFor(() => tcpRefused(p), { timeout: 10_000, what: `que se cierre ${k} (${p})` })
    await shot(A, "accesos-liberados")
    // Unplug the cable while reserved: the JTAG access waits for it and restarts on replug (another USB socket).
    await main(A).getByRole("button", { name: "Reservar", exact: true }).first().click()
    await main(A).getByText(/^Tuyo/).first().waitFor()
    await waitFor(async () => !(await tcpRefused(ports[JTAG0.key])), { timeout: 20_000, what: `${JTAG0.label} abierto otra vez` })
    unplugCable(path.join(ctx.tmp, "jtag-sys"), JTAG_SERIAL)
    await waitFor(async () => /Cable no conectado/.test(await card(JTAG0.label).innerText()), { timeout: 15_000, what: "«Cable no conectado»" })
    assert(await tcpRefused(ports[JTAG0.key]), "el hw_server sigue escuchando sin cable")
    plugCable(path.join(ctx.tmp, "jtag-sys"), { serial: JTAG_SERIAL, port: "8" })
    await waitFor(async () => /Abierto/.test(await card(JTAG0.label).innerText()), { timeout: 20_000, what: `${JTAG0.label} abierto tras reconectar el cable` })
    // A quiet xsdb session (no web activity): seen by the kernel-table poll, it renews the reservation, the web shows it,
    // and "Liberar" asks first, listing it.
    const sseFrom = ctx.sse.events.length
    const xsdb = net.connect({ host: "127.0.0.1", port: ports[JTAG0.key] })
    let xsdbClosed = false
    xsdb.on("data", () => {})
    xsdb.on("error", () => {})
    xsdb.on("close", () => { xsdbClosed = true })
    await waitFor(async () => /En uso por xsdb\/Vivado desde 127\.0\.0\.1/.test(await card(JTAG0.label).innerText()), { timeout: 15_000, what: "la sesión xsdb en la tarjeta" })
    const renew = await ctx.sse.waitFor((e) => ctx.sse.events.indexOf(e) >= sseFrom && e.type === "reservation.changed" && e.data.equipmentId === eq2Id && e.data.cause === "renew", "renovación por la sesión remota", 15_000)
    await main(A).getByText("1 sesión remota").first().waitFor()
    await main(A).getByRole("button", { name: "Liberar" }).first().click()
    const confirm = A.getByRole("alertdialog").filter({ hasText: `¿Liberar ${EQ2}?` })
    await confirm.waitFor()
    const listed = (await confirm.innerText()).replace(/\s+/g, " ")
    assert(listed.includes(`${JTAG0.label}: en uso por xsdb/Vivado desde 127.0.0.1 · se cerrará`), `confirmación de Liberar: ${listed}`)
    await shot(A, "accesos-liberar-con-sesiones")
    await confirm.getByRole("button", { name: "Liberar" }).click()
    await main(A).getByRole("button", { name: "Reservar", exact: true }).first().waitFor()
    await waitFor(() => tcpRefused(ports[JTAG0.key]), { timeout: 10_000, what: `que se cierre ${JTAG0.label}` })
    await waitFor(() => xsdbClosed, { timeout: 10_000, what: "que se corte la sesión xsdb" })
    assert(renew.data.reservation?.holderUsername, "renovación sin titular")
    const hwLines = ctx.server.log().split("\n").filter((l) => l.includes("Arrancando hw_server"))
    return `puertos ${Object.values(ports).join(", ")}; ${hwLines.length} arranques de hw_server; «${hwLines[0]?.replace(/^.*orden=/, "") ?? ""}»`
  })

  await step("5g", "Sistema › Accesos: mapa de puertos y cables", async () => {
    await A.goto(`${BASE}/sistema/accesos`)
    await main(A).getByRole("heading", { name: "Mapa de puertos" }).waitFor()
    const t = (await main(A).innerText()).replace(/\s+/g, " ")
    assert(t.includes(`Rango ${ACCESS_BASE}-${ACCESS_BASE + 29} en 127.0.0.1`) && /fake-hw-server\.mjs/.test(t) && /JTAG-01/.test(t), `Sistema › Accesos: ${t.slice(0, 400)}`)
    await shot(A, "sistema-accesos")
    return "rango, hw_server simulado y JTAG-01 asignado"
  })

  await step("5e", "Descubrimiento: «Buscar placas (UDP)» encuentra el dS378 ya registrado", async () => {
    await A.goto(`${BASE}/descubrimiento?tab=reles`)
    const btn = main(A).getByRole("button", { name: "Buscar placas (UDP)" }).first()
    await btn.waitFor()
    await btn.click()
    await main(A).getByText(/Búsqueda UDP terminada: 1 placa respondió/).first().waitFor({ timeout: 20_000 })
    await main(A).getByText("Registrada: dS378 banco").first().waitFor()
    await shot(A, "descubrimiento-udp")
    const rows = await api.get("/api/audit?action=discovery.relay.udp&limit=5")
    const n = ((await rows.json()).items ?? []).length
    assert(n >= 1, "la búsqueda UDP no está en la auditoría")
    return "1 placa respondió; «Registrada: dS378 banco»; auditada"
  })

  const oper = await newPage("operador")
  const O = oper.page

  await step("5d", "Operador: primer acceso con cambio de contraseña obligatorio", async () => {
    await uiLogin(O, OPER.username, OPER.firstPassword)
    await O.waitForURL(/\/cuenta\?cambiar=1/, { timeout: 20_000 })
    await O.locator("input[name=currentPassword]").fill(OPER.firstPassword)
    await O.locator("input[name=newPassword]").fill(OPER.password)
    await O.locator("input[name=confirmPassword]").fill(OPER.password)
    await shot(O, "operador-cambio-contrasena")
    await O.getByRole("button", { name: "Cambiar contraseña" }).click()
    // The form signs in again with the new password and then navigates to "/" by itself ("/login" on failure).
    await O.waitForURL((u) => u.pathname === "/" || u.pathname === "/login", { timeout: 30_000 })
    assert(new URL(O.url()).pathname === "/", `tras cambiar la contraseña la página va a ${O.url()} (el nuevo acceso automático ha fallado)`)
    await main(O).getByRole("article", { name: EQ1 }).waitFor()
    assert((await O.getByRole("link", { name: "Usuarios" }).count()) === 0, "el operador ve la navegación de administración")
    await shot(O, "operador-banco")
    for (const u of ["/usuarios", "/plantillas", "/plantillas/nueva", "/equipos/nuevo", "/placas", "/descubrimiento", "/sistema/salud", "/auditoria"]) {
      await O.goto(`${BASE}${u}`)
      await O.waitForURL((x) => x.pathname === "/", { timeout: 10_000 }).catch(() => {})
      assert(new URL(O.url()).pathname === "/", `el operador en ${u} acaba en ${O.url()} (se esperaba /)`)
    }
    return "contraseña cambiada; Banco sin menús de administración; 8 URL de administración → /"
  })

  await step("5d2", "Tema en la cuenta: Rosa se aplica antes de pintar en otro navegador, en directo en otras pestañas, y cada usuario conserva el suyo", async () => {
    const themeOf = (page) => page.evaluate(() => document.documentElement.getAttribute("data-theme"))
    /** data-theme and data-theme-user of <html> in the HTML the server sent (before any script ran). */
    const initialHtml = async (page, p = "/") => {
      const res = await page.goto(`${BASE}${p}`)
      const tag = /<html\b[^>]*>/.exec(await res.text())?.[0] ?? ""
      return { theme: /\sdata-theme="([a-z]*)"/.exec(tag)?.[1] ?? null, user: /\sdata-theme-user="([a-z]*)"/.exec(tag)?.[1] ?? null }
    }
    const pick = async (page, label) => {
      await page.getByRole("button", { name: /^Tema: / }).click()
      await page.getByRole("menuitemradio", { name: label, exact: true }).click()
    }
    const logout = async (page) => {
      await page.getByRole("button", { name: /^Menú de usuario/ }).click()
      await page.getByRole("menuitem", { name: "Cerrar sesión" }).click()
      await page.waitForURL(/\/login/, { timeout: 20_000 })
    }
    const dbTheme = async (username) => (await dbQuery("SELECT theme FROM User WHERE username = ?", username))[0]?.theme ?? null
    const waitTheme = (page, want, what) => waitFor(async () => (await themeOf(page)) === want, { timeout: 10_000, what })

    // 1. The operator picks Rosa: applied at once and saved in the account.
    assert((await dbTheme(OPER.username)) === null, "el operador ya tenía un tema en la cuenta")
    await O.goto(`${BASE}/`)
    await pick(O, "Rosa")
    assert((await themeOf(O)) === "rosa", "Rosa no se aplica al momento")
    await waitFor(async () => (await dbTheme(OPER.username)) === "rosa", { what: "que el tema Rosa se guarde en la cuenta del operador" })
    await shot(O, "tema-rosa")
    // 2. Logged out, this browser's login page keeps the last user's theme (the cache).
    await logout(O)
    assert((await themeOf(O)) === "rosa", `la página de acceso tras cerrar sesión tiene el tema ${await themeOf(O)}`)

    // 3. Another browser (new profile, empty localStorage): Rosa is in the very first HTML after signing in.
    const other = await newPage("tema-otro-navegador")
    const F = other.page
    await F.goto(`${BASE}/login`)
    assert((await themeOf(F)) === "dark", "un navegador nuevo no empieza en oscuro")
    await uiLogin(F, OPER.username, OPER.password)
    const first = await initialHtml(F)
    assert(first.theme === "rosa" && first.user === "rosa", `HTML inicial del operador en otro navegador: ${JSON.stringify(first)}`)
    assert((await themeOf(F)) === "rosa", "Rosa no está aplicado en el otro navegador")
    assert((await F.evaluate(() => localStorage.getItem("rm-theme"))) === "rosa", "la caché del navegador no tiene el tema de la cuenta")
    await shot(F, "tema-rosa-otro-navegador")

    // 4. Back in the first browser; a change in one browser reaches the other one live (account.prefs.changed).
    await uiLogin(O, OPER.username, OPER.password)
    assert((await initialHtml(O)).theme === "rosa", "el operador no vuelve a entrar con Rosa")
    await pick(F, "Claro")
    await waitTheme(O, "light", "que el tema Claro llegue en directo al otro navegador del operador")
    await pick(F, "Rosa")
    await waitTheme(O, "rosa", "que Rosa vuelva en directo al otro navegador del operador")

    // 5. A second user on the same browser keeps their own theme: never the cached one of the previous user.
    await logout(F)
    assert((await themeOf(F)) === "rosa", "la página de acceso no muestra el tema del último usuario")
    await uiLogin(F, ADMIN.username, ADMIN.password)
    const adm = await initialHtml(F)
    assert(adm.theme === "dark" && adm.user === "", `HTML inicial del administrador tras el operador: ${JSON.stringify(adm)}`)
    assert((await themeOf(F)) === "dark", `el administrador ve el tema ${await themeOf(F)} (el del operador era Rosa)`)
    await sleep(500)
    assert((await dbTheme(ADMIN.username)) === null, "la cuenta del administrador ha adoptado el tema del operador")
    await pick(F, "Claro")
    await waitFor(async () => (await dbTheme(ADMIN.username)) === "light", { what: "que el tema Claro se guarde en la cuenta del administrador" })
    await waitTheme(A, "light", "que el tema Claro llegue en directo a la otra sesión del administrador")
    assert((await initialHtml(F)).theme === "light", "el administrador no vuelve a cargar con Claro")
    assert((await dbTheme(OPER.username)) === "rosa" && (await themeOf(O)) === "rosa", "el tema del operador ha cambiado")
    await shot(F, "tema-claro-administrador")

    // Back to the default for the rest of the run.
    await pick(F, "Oscuro (predeterminado)")
    await waitTheme(A, "dark", "que el administrador vuelva a Oscuro")
    await pick(O, "Oscuro (predeterminado)")
    await waitFor(async () => (await dbTheme(OPER.username)) === "dark", { what: "que el operador vuelva a Oscuro" })
    await other.context.close()
    ctx.pages = ctx.pages.filter((p) => p !== other)
    assert(!other.errors.length, `errores del navegador: ${other.errors.join(" | ")}`)
    return "Rosa guardado en la cuenta; HTML inicial con data-theme=\"rosa\" en un perfil nuevo; cambios en directo entre navegadores; el administrador conserva el suyo"
  })

  await step("6", "Espacio de trabajo en solo lectura: historial repetido y escritura bloqueada", async () => {
    await A.goto(`${BASE}/equipos/${eq1.id}`)
    await pane(A, "UART0").waitFor()
    await waitTerm(A, "UART0", /login:/, "«login:» del arranque repetido")
    const before = ctx.secIfWs.text().length
    await typeInTerminal(A, "UART1", "xyz")
    await main(A).getByText("Reserva el equipo para escribir").first().waitFor()
    await sleep(800)
    assert(!/xyz/.test(await termText(A, "UART1")), "la consola UART1 ha recibido (y devuelto) lo tecleado en solo lectura")
    assert(ctx.secIfWs.text().length === before || !/xyz/.test(ctx.secIfWs.text()), "la consola ha recibido texto en solo lectura")
    await shot(A, "espacio-solo-lectura")
    return "UART0 muestra «login:»; tecleo en solo lectura sin eco"
  })

  await step("7", "Reservar y escribir: «root» + Intro → «Password:»", async () => {
    await main(A).getByRole("button", { name: "Reservar", exact: true }).first().click()
    await main(A).getByText(/^Tuyo/).first().waitFor()
    await typeInTerminal(A, "UART1", "root", true)
    await waitTerm(A, "UART1", /Password:/, "«Password:»")
    await typeInTerminal(A, "UART1", "secreto-e2e", true)
    await waitTerm(A, "UART1", /root@equipo-a-01-uart1:~#/, "el prompt del shell")
    await typeInTerminal(A, "UART1", "uname", true)
    await waitTerm(A, "UART1", /uname: not found/, "la respuesta del shell simulado")
    await shot(A, "espacio-reservado")
    return "chip «Tuyo», login en UART1 y shell"
  })

  await step("7b", "Segundo usuario: ve la salida en directo y no puede escribir (navegador y WebSocket)", async () => {
    await O.goto(`${BASE}/equipos/${eq1.id}`)
    await pane(O, "UART1").waitFor()
    await waitTerm(O, "UART1", /root@equipo-a-01-uart1:~#/, "el historial de UART1 (operador)")
    await main(O).getByText("Solo lectura. Reservado por A. E2E", { exact: false }).first().waitFor()
    await typeInTerminal(O, "UART1", "lsop", true)
    await sleep(800)
    assert(!/lsop/.test(await termText(O, "UART1")), "la consola ha recibido lo que teclea el operador en solo lectura")
    await typeInTerminal(A, "UART1", "echo-admin", true)
    await waitTerm(O, "UART1", /echo-admin: not found/, "la salida en directo de la reserva de otro")
    const opApi = new HttpSession(BASE)
    assert((await opApi.login(OPER.username, OPER.password)).ok, "login HTTP del operador")
    const ws = openConsoleWs(opApi, consoles1.UART1)
    ctx.sockets.push(ws)
    const hello = await ws.waitMsg((m) => m.t === "hello", "hello (operador)")
    assert(hello.mode === "ro", `modo del operador: ${hello.mode}`)
    ws.send("reboot\r")
    const rej = await ws.waitMsg((m) => m.t === "input-rejected", "input-rejected")
    assert(rej.reason === "not-holder", `motivo del rechazo: ${rej.reason}`)
    ctx.opApi = opApi
    ctx.opWs = ws
    await shot(O, "operador-solo-lectura")
    return `hello ro; entrada rechazada (${rej.reason}); la salida llega en directo`
  })

  await step("7c", "Archivos: subir desde el navegador, verlo en directo desde otro usuario, descargar, renombrar y borrar", async () => {
    const filesDir = path.join(ctx.tmp, "tftp")
    const sha = (b) => crypto.createHash("sha256").update(b).digest("hex")
    const fa = await newPage("archivos-admin")
    const fo = await newPage("archivos-operador")
    const FA = fa.page
    const FO = fo.page
    await uiLogin(FA, ADMIN.username, ADMIN.password)
    await uiLogin(FO, OPER.username, OPER.password)
    await FA.goto(`${BASE}/archivos`)
    await FO.goto(`${BASE}/archivos`)
    await main(FA).getByRole("heading", { name: "Archivos", level: 1 }).waitFor()
    await main(FO).getByRole("heading", { name: "Archivos", level: 1 }).waitFor()
    const serverPath = (await main(FA).getByTestId("files-server-path").innerText()).trim()
    assert(serverPath === filesDir, `ruta del servidor para el administrador: «${serverPath}» (se esperaba ${filesDir})`)
    assert((await main(FO).getByTestId("files-server-path").count()) === 0, "el operador ve la ruta del servidor")
    assert((await FO.getByRole("link", { name: "Archivos" }).count()) > 0, "el operador no tiene «Archivos» en la navegación")
    await main(FO).getByText("Esta carpeta está vacía").waitFor()
    // Upload through the page (file input), 3 MiB of random bytes with a non-ASCII name.
    const name = "imagen e2e ñ.bin"
    const data = crypto.randomBytes(3 * 1024 * 1024 + 17)
    const local = path.join(ctx.tmp, name)
    fs.writeFileSync(local, data)
    await main(FA).getByTestId("files-input").setInputFiles(local)
    await main(FA).getByRole("link", { name, exact: true }).waitFor({ timeout: 20_000 })
    await FA.getByRole("region", { name: "Subidas de archivos" }).getByText("Subido").waitFor()
    // The other user sees it without reloading (files.changed over SSE).
    const t = Date.now()
    await main(FO).getByRole("link", { name, exact: true }).waitFor({ timeout: 10_000 })
    const liveMs = Date.now() - t
    assert(fs.existsSync(path.join(filesDir, name)), `no está en ${filesDir}`)
    assert(sha(fs.readFileSync(path.join(filesDir, name))) === sha(data), "el archivo en el disco no coincide")
    assert((fs.statSync(path.join(filesDir, name)).mode & 0o777) === 0o664, "el archivo subido no tiene permisos 664")
    await shot(FA, "archivos-subido")
    // Download from the operator's page and compare.
    const [dl] = await Promise.all([FO.waitForEvent("download"), main(FO).getByRole("link", { name: `Descargar ${name}` }).click()])
    assert(dl.suggestedFilename() === name, `nombre de la descarga: ${dl.suggestedFilename()}`)
    assert(sha(fs.readFileSync(await dl.path())) === sha(data), "la descarga no coincide con lo subido")
    // A folder (created on the server by other means) downloaded as .zip and as .tar.gz from the format menu.
    fs.mkdirSync(path.join(filesDir, "lote", "sub", "vacía"), { recursive: true })
    const nested = crypto.randomBytes(200_000)
    fs.writeFileSync(path.join(filesDir, "lote", "sub", "anidado ñ.bin"), nested)
    fs.writeFileSync(path.join(filesDir, "lote", "leeme.txt"), "hola")
    await main(FA).getByRole("button", { name: "Actualizar" }).click()
    await main(FA).getByRole("link", { name: "lote", exact: true }).waitFor()
    const formats = []
    for (const [label, ext] of [["ZIP (.zip)", "zip"], ["TAR.GZ (.tar.gz)", "tar.gz"]]) {
      await main(FA).getByRole("button", { name: "Descargar la carpeta lote" }).click()
      const item = FA.getByRole("menuitem", { name: label })
      await item.waitFor()
      if (ext === "tar.gz") await shot(FA, "archivos-descargar-como")
      const [arc] = await Promise.all([FA.waitForEvent("download"), item.click()])
      assert(arc.suggestedFilename() === `lote.${ext}`, `nombre del archivo comprimido: ${arc.suggestedFilename()}`)
      const out = path.join(ctx.tmp, `x-${ext}`)
      fs.mkdirSync(out, { recursive: true })
      const r = ext === "zip" ? spawnSync("unzip", ["-q", await arc.path(), "-d", out], { encoding: "utf8" })
        : spawnSync("tar", ["-xzf", await arc.path(), "-C", out], { encoding: "utf8" })
      assert(r.status === 0, `no se puede extraer lote.${ext}: ${r.stderr}`)
      assert(sha(fs.readFileSync(path.join(out, "lote", "sub", "anidado ñ.bin"))) === sha(nested), `lote.${ext}: el fichero anidado no coincide`)
      assert(fs.readFileSync(path.join(out, "lote", "leeme.txt"), "utf8") === "hola", `lote.${ext}: falta leeme.txt`)
      assert(fs.statSync(path.join(out, "lote", "sub", "vacía")).isDirectory(), `lote.${ext}: falta la carpeta vacía`)
      formats.push(ext)
    }
    // The last choice comes first next time.
    await main(FA).getByRole("button", { name: "Descargar la carpeta lote" }).click()
    const first = await FA.getByRole("menuitem").first().innerText()
    assert(/TAR\.GZ/.test(first) && /la última vez/.test(first), `el menú no recuerda el último formato: «${first}»`)
    await FA.keyboard.press("Escape")
    fs.rmSync(path.join(filesDir, "lote"), { recursive: true })
    // Rename.
    await main(FA).getByRole("button", { name: `Más acciones: ${name}` }).click()
    await FA.getByRole("menuitem", { name: "Cambiar nombre" }).click()
    const rd = FA.getByRole("dialog")
    await rd.getByLabel("Nombre nuevo").fill("renombrado.bin")
    await rd.getByRole("button", { name: "Guardar" }).click()
    await main(FA).getByRole("link", { name: "renombrado.bin", exact: true }).waitFor()
    await main(FO).getByRole("link", { name: "renombrado.bin", exact: true }).waitFor({ timeout: 10_000 })
    assert(fs.existsSync(path.join(filesDir, "renombrado.bin")) && !fs.existsSync(path.join(filesDir, name)), "el cambio de nombre no se ve en el disco")
    // Delete (confirmed).
    await main(FA).getByRole("button", { name: "Más acciones: renombrado.bin" }).click()
    await FA.getByRole("menuitem", { name: "Borrar" }).click()
    const ad = FA.getByRole("alertdialog")
    await ad.getByText("¿Borrar «renombrado.bin»?").waitFor()
    await shot(FA, "archivos-borrar")
    await ad.getByRole("button", { name: "Borrar" }).click()
    await main(FA).getByText("Esta carpeta está vacía").waitFor()
    await main(FO).getByText("Esta carpeta está vacía").waitFor({ timeout: 10_000 })
    assert(!fs.existsSync(path.join(filesDir, "renombrado.bin")), "el archivo sigue en el disco tras borrarlo")
    // The API refuses to leave the folder.
    const esc = await api.get(`/api/files/download?path=${encodeURIComponent("../data/auth-secret")}`)
    assert(esc.status === 400, `descarga con .. → ${esc.status}`)
    await fa.context.close()
    await fo.context.close()
    ctx.pages = ctx.pages.filter((p) => p !== fa && p !== fo)
    const errs = [...fa.errors, ...fo.errors]
    assert(!errs.length, `errores del navegador en Archivos: ${errs.join(" | ")}`)
    return `subido (${data.length} B, sha256 igual en el disco y en la descarga), visto por el operador en ${liveMs} ms, carpeta descargada como ${formats.join(" y ")}, renombrado y borrado`
  })

  await step("7d", "Archivos › Enviar a equipo: clic derecho, SSH por la Ethernet del equipo importado (IP:puerto), verificado y recordado", async () => {
    const filesDir = path.join(ctx.tmp, "tftp")
    const sha = (b) => crypto.createHash("sha256").update(b).digest("hex")
    const data = crypto.randomBytes(2 * 1024 * 1024 + 99)
    fs.writeFileSync(path.join(filesDir, "BOOT.BIN"), data)
    const fs1 = await newPage("enviar-admin")
    const S = fs1.page
    await uiLogin(S, ADMIN.username, ADMIN.password)
    await S.goto(`${BASE}/archivos`)
    const row = main(S).locator('tr[data-entry="BOOT.BIN"]')
    await row.waitFor()
    // Right click on the row → «Enviar a equipo…».
    await row.click({ button: "right" })
    await S.getByRole("menuitem", { name: "Enviar a equipo…" }).click()
    const dlg = S.getByRole("dialog").filter({ hasText: "Enviar «BOOT.BIN» a un equipo" })
    await dlg.waitFor()
    const eq1Card = dlg.getByRole("radio", { name: new RegExp(reEsc(EQ1)) })
    await eq1Card.waitFor()
    const eq1Text = (await eq1Card.innerText()).replace(/\s+/g, " ")
    assert(eq1Text.includes(`127.0.0.1:${ctx.ssh.port}`) && /Reservado por ti/.test(eq1Text), `${EQ1} en el diálogo: ${eq1Text}`)
    assert((await eq1Card.getAttribute("aria-checked")) === "true", `${EQ1} (reservado por mí) no está elegido`)
    const eq2Text = (await dlg.getByRole("radio", { name: new RegExp(reEsc(EQ2)) }).innerText()).replace(/\s+/g, " ")
    assert(/Puerto 5 del switch · enlace activo/.test(eq2Text) && /Reserva el equipo para enviarle archivos/.test(eq2Text), `${EQ2} en el diálogo: ${eq2Text}`)
    assert((await dlg.getByLabel("Usuario").inputValue()) === "root", "usuario por defecto")
    assert((await dlg.getByLabel("Contraseña").inputValue()) === "root", "contraseña por defecto")
    assert((await dlg.getByLabel("Ruta de destino").inputValue()) === "~", "ruta por defecto")
    await dlg.getByRole("checkbox", { name: "Recordar para este equipo" }).check()
    await shot(S, "enviar-dialogo")
    await dlg.getByRole("button", { name: "Enviar" }).click()
    await dlg.waitFor({ state: "detached" })
    const panel = S.getByRole("region", { name: "Envíos a equipos" })
    const sent = panel.locator('li[data-send-name="BOOT.BIN"]').last()
    await waitFor(async () => (await sent.getAttribute("data-send-status")) === "done", { timeout: 20_000, what: "«Enviado» en el panel Envíos" })
    const rowText = (await sent.innerText()).replace(/\s+/g, " ")
    assert(/Enviado/.test(rowText) && /verificado \(SHA-256\)/.test(rowText) && rowText.includes(`root@${ctx.ssh.home}/BOOT.BIN`), `fila del envío: ${rowText}`)
    await shot(S, "enviar-panel")
    const onEquipment = path.join(ctx.ssh.home, "BOOT.BIN")
    assert(fs.existsSync(onEquipment) && sha(fs.readFileSync(onEquipment)) === sha(data), "el archivo no ha llegado entero al equipo")
    // Remembered: the password is sealed in the database, never in the page; the second send uses it (empty field).
    const [prof] = await dbQuery("SELECT remembered, username, password, destPath, hostKeyFingerprint FROM EquipmentSshProfile WHERE equipmentId = ?", eq1.id)
    assert(prof?.remembered === 1 && prof.username === "root" && /^v1:/.test(prof.password) && !prof.password.includes("root") && /^SHA256:/.test(prof.hostKeyFingerprint), `perfil guardado: ${JSON.stringify({ ...prof, password: prof?.password?.slice(0, 3) })}`)
    fs.writeFileSync(path.join(filesDir, "BOOT.BIN"), Buffer.concat([data, Buffer.from("v2")]))
    await main(S).getByRole("button", { name: "Más acciones: BOOT.BIN" }).click()
    await S.getByRole("menuitem", { name: "Enviar a equipo…" }).click()
    await dlg.waitFor()
    await dlg.getByRole("radio", { name: new RegExp(reEsc(EQ1)) }).waitFor()
    assert((await dlg.getByLabel("Contraseña").inputValue()) === "", "la contraseña guardada ha llegado al navegador")
    assert(/guardada/.test(await dlg.getByLabel("Contraseña").getAttribute("placeholder")), "sin «(guardada)» en la contraseña")
    const html = await S.content()
    assert(!html.includes(prof.password), "el valor cifrado está en la página")
    await dlg.getByRole("button", { name: "Enviar" }).click()
    await dlg.waitFor({ state: "detached" })
    await waitFor(async () => (await panel.locator('li[data-send-status="done"]').count()) === 2, { timeout: 20_000, what: "el segundo envío" })
    assert(fs.readFileSync(onEquipment).length === data.length + 2, "el segundo envío no ha reemplazado el archivo")
    // The operator cannot send to an equipment reserved by someone else (API).
    const denied = await ctx.opApi.post("/api/files/send", JSON.stringify({ paths: ["BOOT.BIN"], equipmentId: eq1.id, username: "root", password: "root", destPath: "~", remember: false }), { headers: { "content-type": "application/json" } })
    const deniedBody = await denied.json()
    assert(denied.status === 403 && /Reserva el equipo para enviarle archivos/.test(deniedBody.message), `operador: ${denied.status} ${JSON.stringify(deniedBody)}`)
    // Audit: sends with checksum, never the password.
    const rowsA = await dbQuery("SELECT action, outcome, detail FROM AuditEvent WHERE action LIKE 'files.send%' ORDER BY id")
    assert(rowsA.filter((r) => r.action === "files.send" && r.outcome === "ok").length === 2 && rowsA.some((r) => r.action === "files.send" && r.outcome === "denied"), `auditoría: ${JSON.stringify(rowsA.map((r) => [r.action, r.outcome]))}`)
    assert(rowsA.every((r) => !/"root"\s*}|password|v1:/.test(r.detail ?? "")) && rowsA.some((r) => /verificado/.test(r.detail ?? "")), `detalle de auditoría: ${rowsA.map((r) => r.detail).join(" | ")}`)
    assert(ctx.ssh.logins.filter((l) => l.ok).length === 2, `accesos SSH al equipo simulado: ${JSON.stringify(ctx.ssh.logins)}`)
    await fs1.context.close()
    ctx.pages = ctx.pages.filter((p) => p !== fs1)
    assert(!fs1.errors.length, `errores del navegador en Enviar a equipo: ${fs1.errors.join(" | ")}`)
    fs.rmSync(path.join(filesDir, "BOOT.BIN"))
    return `2 envíos por SFTP a 127.0.0.1:${ctx.ssh.port} (sha256 igual, «verificado»), contraseña recordada cifrada, operador rechazado`
  })

  await step("7e", "Archivos › Copiar a una carpeta del servidor: el administrador copia a un «pendrive» (carpeta temporal) desde el diálogo; el operador no ve la opción", async () => {
    const filesDir = path.join(ctx.tmp, "tftp")
    const sha = (b) => crypto.createHash("sha256").update(b).digest("hex")
    const name = "copia e2e ñ.bin"
    const data = crypto.randomBytes(1024 * 1024 + 7)
    fs.writeFileSync(path.join(filesDir, name), data)
    const usb = path.join(ctx.tmp, "usb-e2e")
    const locked = path.join(usb, "solo-root")
    fs.mkdirSync(locked, { recursive: true })
    fs.chmodSync(locked, 0o555)
    const pg = await newPage("copiar-admin")
    const C = pg.page
    await uiLogin(C, ADMIN.username, ADMIN.password)
    await C.goto(`${BASE}/archivos`)
    const row = main(C).locator(`tr[data-entry="${name}"]`)
    await row.waitFor()
    await row.click({ button: "right" })
    await C.getByRole("menuitem", { name: "Copiar a una carpeta del servidor…" }).click()
    const dlg = C.getByRole("dialog").filter({ hasText: `Copiar «${name}» a una carpeta del servidor` })
    await dlg.waitFor()
    await dlg.getByRole("heading", { name: "Unidades USB y discos" }).waitFor()
    // A folder the service cannot write: «Solo como administrador», and here (portable) no helper: the reason is shown.
    await dlg.getByTestId("copy-location").fill(locked)
    await dlg.getByTestId("copy-location").press("Enter")
    await waitFor(async () => (await dlg.getByTestId("copy-dest").innerText()).trim() === locked, { timeout: 10_000, what: "la carpeta solo-root" })
    await dlg.getByText("Solo como administrador (sudo)").first().waitFor()
    await dlg.getByText("La copia como administrador no está disponible:").waitFor()
    assert(await dlg.getByRole("button", { name: "Copiar aquí" }).isDisabled(), "«Copiar aquí» activo en una carpeta sin permiso")
    await shot(C, "copiar-sin-permiso")
    // The «USB»: writable by the service; a new folder inside it; copy there.
    await dlg.getByTestId("copy-location").fill(usb)
    await dlg.getByRole("button", { name: "Ir", exact: true }).click()
    await waitFor(async () => (await dlg.getByTestId("copy-dest").innerText()).trim() === usb, { timeout: 10_000, what: "la carpeta del pendrive" })
    await dlg.getByText("El servicio puede escribir aquí").waitFor()
    await dlg.locator('button[data-folder="solo-root"]').waitFor()
    await dlg.getByRole("button", { name: "Nueva carpeta" }).click()
    await dlg.getByLabel("Nombre de la carpeta").fill("fotos")
    await dlg.getByRole("button", { name: "Crear", exact: true }).click()
    const dest = path.join(usb, "fotos")
    await waitFor(async () => (await dlg.getByTestId("copy-dest").innerText()).trim() === dest, { timeout: 10_000, what: "entrar en la carpeta nueva" })
    assert(fs.statSync(dest).isDirectory(), "la carpeta nueva no existe")
    await dlg.getByRole("radio", { name: "Reemplazar" }).click()
    await shot(C, "copiar-dialogo")
    await dlg.getByRole("button", { name: "Copiar aquí" }).click()
    await dlg.waitFor({ state: "detached" })
    const panel = C.getByRole("region", { name: "Copias a carpetas del servidor" })
    const item = panel.locator(`li[data-copy-name="${name}"]`).last()
    await waitFor(async () => (await item.getAttribute("data-copy-status")) === "done", { timeout: 20_000, what: "«Copiado» en el panel Copias" })
    const itemText = (await item.innerText()).replace(/\s+/g, " ")
    assert(/Copiado/.test(itemText) && /Verificado \(sha256\)/.test(itemText) && itemText.includes(`${dest}/${name}`), `fila de la copia: ${itemText}`)
    await shot(C, "copiar-panel")
    const copied = path.join(dest, name)
    assert(fs.existsSync(copied) && sha(fs.readFileSync(copied)) === sha(data), "la copia no coincide con el original")
    assert((fs.statSync(copied).mode & 0o777) === 0o644, `permisos de la copia: ${(fs.statSync(copied).mode & 0o777).toString(8)}`)
    assert(fs.readdirSync(dest).every((n) => !n.startsWith(".rm-copy-")), "quedan temporales de copia")
    // The operator (not an administrator): no option in the menus, and the API refuses.
    const po = await newPage("copiar-operador")
    const O = po.page
    await uiLogin(O, OPER.username, OPER.password)
    await O.goto(`${BASE}/archivos`)
    const orow = main(O).locator(`tr[data-entry="${name}"]`)
    await orow.waitFor()
    await orow.click({ button: "right" })
    await O.getByRole("menuitem", { name: "Enviar a equipo…" }).waitFor()
    assert((await O.getByRole("menuitem", { name: "Copiar a una carpeta del servidor…" }).count()) === 0, "el operador ve «Copiar a una carpeta del servidor…»")
    await O.keyboard.press("Escape")
    const denied = await ctx.opApi.post("/api/files/copy", JSON.stringify({ paths: [name], destDir: usb, conflict: "keep", asRoot: false, password: null }), { headers: { "content-type": "application/json" } })
    assert(denied.status === 403, `API para el operador: ${denied.status}`)
    const deniedBody = await denied.text()
    assert(!fs.existsSync(path.join(usb, name)), "el operador ha copiado")
    // The audit row of the refusal is written right after the 403: give it a moment.
    let rowsA = []
    for (let i = 0; i < 20; i++) {
      rowsA = await dbQuery("SELECT action, outcome, detail FROM AuditEvent WHERE action LIKE 'files.copy%' ORDER BY id")
      if (rowsA.some((r) => r.action === "files.copy" && r.outcome === "denied")) break
      await new Promise((r) => setTimeout(r, 150))
    }
    assert(rowsA.some((r) => r.action === "files.copy" && r.outcome === "ok" && /"asRoot":false/.test(r.detail)) && rowsA.some((r) => r.action === "files.copy.mkdir")
      && rowsA.some((r) => r.action === "files.copy" && r.outcome === "denied"), `auditoría: ${JSON.stringify(rowsA.map((r) => [r.action, r.outcome]))} (respuesta al operador: ${deniedBody})`)
    for (const p of [pg, po]) {
      await p.context.close()
      ctx.pages = ctx.pages.filter((x) => x !== p)
      assert(!p.errors.length, `errores del navegador en Copiar: ${p.errors.join(" | ")}`)
    }
    fs.chmodSync(locked, 0o755)
    fs.rmSync(path.join(filesDir, name))
    return `copiado a ${dest} (sha256 igual, 0644, carpeta nueva desde el diálogo), carpeta sin permiso explicada, operador sin la opción (403)`
  })

  await step("7f", "Archivos › segunda carpeta (raíz «extra», nombre del perfil) y el script de descarga del perfil: registro en directo y el zip en la lista", async () => {
    const extraDir = EFF.extraDir
    const exportDir = EFF.exportRoot === "extra" ? extraDir : path.join(ctx.tmp, "tftp")
    const sha = (b) => crypto.createHash("sha256").update(b).digest("hex")
    // The API: the second root lists apart from tftp, and the work folder of the downloads is never shown.
    fs.writeFileSync(path.join(extraDir, "leeme-extra.txt"), "segunda carpeta")
    const le = await (await api.get("/api/files/list?root=extra&path=")).json()
    assert(le.root === "extra" && le.entries.some((e) => e.name === "leeme-extra.txt") && !le.entries.some((e) => e.name === ".descargas"), `listado de extra: ${JSON.stringify(le)}`)
    const lt = await (await api.get("/api/files/list?path=")).json()
    assert(!lt.entries.some((e) => e.name === "leeme-extra.txt"), "lo de la segunda carpeta aparece en tftp")
    const pg = await newPage("extra-admin")
    const E = pg.page
    await uiLogin(E, ADMIN.username, ADMIN.password)
    await E.goto(`${BASE}/archivos`)
    await main(E).getByTestId("files-roots").getByRole("link", { name: EFF.extraName }).click()
    await waitFor(async () => new URL(E.url()).searchParams.get("raiz") === "extra", { timeout: 10_000, what: "?raiz=extra en la dirección" })
    await main(E).getByRole("link", { name: "leeme-extra.txt", exact: true }).waitFor()
    await shot(E, "extra-raiz")
    if (EFF.exportRoot !== "extra") await E.goto(`${BASE}/archivos`)
    // The dialog (texts from the profile): app, version and, only when the profile names it, the «-x» checkbox.
    const app = "demo_app"
    const version = "4.1.0"
    const sseFrom = ctx.sse.events.length
    await main(E).getByRole("button", { name: EFF.exportTitle }).click()
    const dlg = E.getByRole("dialog").filter({ hasText: EFF.exportTitle.replace(/\s*(…|\.\.\.)$/, "") })
    await dlg.waitFor()
    await dlg.getByLabel(EFF.appLabel).fill(app)
    await dlg.getByLabel(EFF.versionLabel).fill(version)
    if (EFF.extractLabel) await dlg.getByLabel(EFF.extractLabel).check()
    else assert((await dlg.getByRole("checkbox").count()) === 0, "sin RM_EXPORT_EXTRACT_LABEL, el diálogo muestra una casilla")
    await shot(E, "descarga-dialogo")
    await dlg.getByRole("button", { name: "Descargar", exact: true }).click()
    const zipName = `${app}-${version}_exports.zip`
    await main(E).getByRole("link", { name: zipName, exact: true }).waitFor({ timeout: 30_000 })
    await ctx.sse.waitFor((e) => ctx.sse.events.indexOf(e) >= sseFrom && e.type === "files.export" && e.data.job.state === "done", "files.export «done»", 30_000)
    const lines = ctx.sse.events.slice(sseFrom).filter((e) => e.type === "files.export").flatMap((e) => e.data.lines)
    assert(lines.length > 0, "el registro del script no llega por SSE")
    if (EFF.fakeDownloader) {
      assert(lines.some((l) => l === `ARG ${app}`) && (!EFF.extractLabel || lines.some((l) => l === "ARG -x")) && lines.some((l) => /All available exports packed/.test(l)), `registro por SSE: ${lines.join(" | ")}`)
      await E.getByText("All available exports packed", { exact: false }).first().waitFor({ timeout: 10_000 })
    }
    await shot(E, "descarga-terminada")
    const zip = path.join(exportDir, zipName)
    assert(fs.existsSync(zip) && (fs.statSync(zip).mode & 0o777) === 0o664, `el zip no está en ${exportDir} con permisos 664`)
    const list = spawnSync("unzip", ["-l", zip], { encoding: "utf8" })
    assert(list.status === 0, `el zip no es válido: ${list.stdout}${list.stderr}`)
    if (EFF.fakeDownloader) assert(new RegExp(`${reEsc(`${app}-${version}`)}/${EFF.extractLabel ? "src/main\\.c" : "export\\.tgz"}`).test(list.stdout), `contenido del zip: ${list.stdout}`)
    assert(!fs.existsSync(path.join(exportDir, ".descargas")), `el script ha trabajado dentro de ${exportDir}`)
    // Download it like any other file.
    const r = await api.get(`/api/files/download?root=${EFF.exportRoot}&path=${encodeURIComponent(zipName)}`)
    assert(r.status === 200 && sha(Buffer.from(await r.arrayBuffer())) === sha(fs.readFileSync(zip)), "la descarga del zip no coincide")
    // A failing script: error with its message (the fake one fails for «fail», the example one for «fallo»); the
    // operator only sees his own jobs.
    const failApp = EFF.fakeDownloader ? "fail" : "fallo"
    const bad = await api.post("/api/files/export", JSON.stringify({ app: failApp, version: "1", extract: false, zipName: null, dir: "" }), { headers: { "content-type": "application/json" } })
    assert(bad.status === 202, `inicio de una descarga que falla: ${bad.status}`)
    const badJob = (await bad.json()).job
    const failed = await ctx.sse.waitFor((e) => e.type === "files.export" && e.data.job.id === badJob.id && e.data.job.state === "error", "files.export «error»", 20_000)
    if (EFF.fakeDownloader) assert(/fallo simulado/.test(failed.data.job.error), `error de la descarga: ${failed.data.job.error}`)
    else assert(failed.data.job.error, "la descarga fallida no tiene mensaje de error")
    const inval = await api.post("/api/files/export", JSON.stringify({ app: "a;id", version: "1", extract: false, zipName: null, dir: "" }), { headers: { "content-type": "application/json" } })
    assert(inval.status === 400, `aplicación con caracteres no válidos: ${inval.status}`)
    const opJobs = await (await ctx.opApi.get("/api/files/export")).json()
    assert(Array.isArray(opJobs.jobs) && opJobs.jobs.length === 0, `el operador ve descargas ajenas: ${JSON.stringify(opJobs.jobs)}`)
    const rows = await dbQuery("SELECT outcome, detail FROM AuditEvent WHERE action = 'files.export' ORDER BY id")
    assert(rows.some((x) => /"result":"exportado"/.test(x.detail)) && rows.some((x) => /"result":"error"/.test(x.detail)), `auditoría files.export: ${JSON.stringify(rows)}`)
    await pg.context.close()
    ctx.pages = ctx.pages.filter((x) => x !== pg)
    assert(!pg.errors.length, `errores del navegador en la segunda carpeta: ${pg.errors.join(" | ")}`)
    fs.rmSync(zip)
    fs.rmSync(path.join(extraDir, "leeme-extra.txt"))
    return `«${EFF.extraName}» (raíz extra); zip ${zipName} en ${EFF.exportRoot} con ${EFF.fakeDownloader ? "el script simulado" : (path.isAbsolute(EFF.downloader) ? path.relative(REPO, EFF.downloader) : EFF.downloader)} (registro en directo, ${lines.length} líneas), error del script mostrado, operador sin descargas ajenas`
  })

  await step("8", "Relés: encender, apagar con confirmación y pulso de reset (verificado en el simulador)", async () => {
    const sw = main(A).getByRole("switch", { name: "Alimentación" })
    await sw.click()
    await waitFor(async () => (await asciiCommand(RELAY_HOST, ASCII_PORT, "GR 1")) === "Active", { what: "GR 1 Active en el simulador" })
    await waitFor(async () => (await sw.getAttribute("aria-checked")) === "true", { what: "el interruptor en ON" })
    await shot(A, "rele-on")
    await sw.click()
    const pop = A.getByRole("alertdialog").filter({ hasText: `¿Cortar la alimentación de ${EQ1}?` })
    await pop.waitFor()
    await shot(A, "rele-confirmar-apagado")
    await pop.getByRole("button", { name: "Apagar" }).click()
    await waitFor(async () => (await asciiCommand(RELAY_HOST, ASCII_PORT, "GR 1")) === "InActive", { what: "GR 1 InActive en el simulador" })
    await waitFor(async () => (await sw.getAttribute("aria-checked")) === "false", { what: "el interruptor en OFF" })
    // Reset pulse (500 ms): the simulator must show the relay on, then off again by itself.
    const seen = []
    let polling = true
    const poller = (async () => {
      while (polling) {
        seen.push(await asciiCommand(RELAY_HOST, ASCII_PORT, "GR 2").catch(() => "?"))
        await sleep(40)
      }
    })()
    const resetItem = main(A).getByRole("listitem").filter({ hasText: "Reset" })
    await resetItem.getByRole("button", { name: "Pulso" }).click()
    const popR = A.getByRole("alertdialog").filter({ hasText: `¿Reiniciar ${EQ1}?` })
    await popR.waitFor()
    await popR.getByRole("button", { name: "Pulso" }).click()
    await waitFor(() => seen.includes("Active"), { timeout: 5000, what: "GR 2 Active durante el pulso" })
    await waitFor(() => seen.lastIndexOf("InActive") > seen.indexOf("Active"), { timeout: 5000, what: "GR 2 InActive tras el pulso" })
    polling = false
    await poller
    await A.getByText("Pulso enviado a Reset").first().waitFor()
    await shot(A, "rele-pulso")
    return `GR 1 Active → InActive; pulso GR 2 visto activo en ${seen.filter((s) => s === "Active").length} lecturas y desactivado después`
  })

  await step("9", "«Soltar puerto» en UART1: el servidor cierra el tty y otro proceso lo abre; «Retomar puerto»", async () => {
    const uart1Pty = fs.realpathSync(path.join(simDir, "ttyV1"))
    assert(fdsPointingAt(ctx.server.pid, uart1Pty).length > 0, "el servidor no tiene abierto UART1 antes de soltarlo")
    await pane(A, "UART1").getByRole("button", { name: "Más acciones de la consola" }).click()
    await A.getByRole("menuitem", { name: "Soltar puerto…" }).click()
    const dlg = dialogWith(A, "¿Soltar el puerto de UART1?")
    await dlg.waitFor()
    await dlg.getByRole("radio", { name: "15 min" }).check()
    await shot(A, "soltar-puerto")
    await dlg.getByRole("button", { name: "Soltar puerto" }).click()
    await waitFor(async () => /Puerto soltado/.test(await paneStatus(A, "UART1")), { what: "estado «Puerto soltado»" })
    await waitFor(() => fdsPointingAt(ctx.server.pid, uart1Pty).length === 0, { timeout: 3000, what: "que el servidor cierre el pty de UART1" })
    const fd = fs.openSync(uart1Pty, fs.constants.O_RDWR | fs.constants.O_NOCTTY | fs.constants.O_NONBLOCK)
    fs.closeSync(fd)
    await shot(A, "puerto-soltado")
    await pane(A, "UART1").getByRole("button", { name: "Más acciones de la consola" }).click()
    await A.getByRole("menuitem", { name: "Retomar puerto" }).click()
    await waitFor(async () => /(Recibiendo|Sin datos)/.test(await paneStatus(A, "UART1")), { what: "estado «Recibiendo» o «Sin datos»" })
    await waitFor(() => fdsPointingAt(ctx.server.pid, uart1Pty).length > 0, { timeout: 3000, what: "que el servidor vuelva a abrir el pty de UART1" })
    await shot(A, "puerto-retomado")
    return `${uart1Pty}: cerrado por el servidor, abierto por otro proceso, retomado`
  })

  await step("9b", "Reconexión USB simulada de UART1 con la reserva activa", async () => {
    const opens = () => ctx.server.log().split("\n").filter((l) => l.includes("Consola abierta consola=UART1")).length
    const before = opens()
    const r = await replugConsole(ctx.bench, "ttyV1")
    const t = Date.now()
    await waitFor(() => opens() > before && fdsPointingAt(ctx.server.pid, r.newTarget).length > 0, { timeout: 3000, interval: 100, what: `que el servidor reabra ${r.newTarget}` })
    const ms = Date.now() - t
    await typeInTerminal(A, "UART1", "", true)
    await waitTerm(A, "UART1", /equipo-a-01-uart1 login:\s*$/m, "el prompt de login tras la reconexión")
    return `reabierto en ${ms} ms; la consola responde`
  })

  await step("9c", "Captura continua: fichero con marcas de tiempo, listado y descarga", async () => {
    const list = await (await api.get(`/api/consoles/${consoles1.UART1}/logs`)).json()
    assert(Array.isArray(list) && list.length > 0, `listado de capturas: ${JSON.stringify(list)}`)
    const main = list.find((f) => !f.name.includes(".input.")) ?? list[0]
    const res = await api.get(`/api/consoles/${consoles1.UART1}/logs/${encodeURIComponent(main.name)}`)
    assert(res.status === 200, `descarga ${main.name}: HTTP ${res.status}`)
    const body = await res.text()
    assert(/Password:/.test(body), "la captura no contiene «Password:»")
    assert(/^\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/m.test(body), "la captura no tiene marcas de tiempo al inicio de línea")
    assert(!/secreto-e2e/.test(body), "la contraseña tecleada aparece en la captura principal")
    const onDisk = fs.readdirSync(path.join(dataDir, "consoles"), { recursive: true }).filter((f) => String(f).endsWith(".log"))
    const opList = await (await ctx.opApi.get(`/api/consoles/${consoles1.UART1}/logs`)).json()
    assert(opList.every((f) => !f.name.includes(".input.")), "el operador ve ficheros .input.log")
    const lines = body.split("\n").filter((l) => /soltado|retomado|Password/.test(l)).slice(0, 4)
    return `${main.name} (${body.length} B, ${onDisk.length} ficheros en disco): ${lines.map((l) => l.trim()).join(" | ")}`
  })

  await step("10", "Liberar: los terminales vuelven a solo lectura", async () => {
    await main(A).getByRole("button", { name: "Liberar" }).first().click()
    await main(A).getByText("Solo lectura. Reserva el equipo para escribir.").first().waitFor()
    await main(A).getByRole("button", { name: "Reservar", exact: true }).first().waitFor()
    await typeInTerminal(A, "UART1", "qwerty")
    await main(A).getByText("Reserva el equipo para escribir").first().waitFor()
    await sleep(800)
    assert(!/qwerty/.test(await termText(A, "UART1")), "UART1 ha recibido (y devuelto) texto tras liberar")
    await shot(A, "liberado")
    return "banner de solo lectura y botón «Reservar»"
  })

  await step("10a", "Forzar liberación: el operador reserva y el administrador libera con motivo", async () => {
    await O.goto(`${BASE}/equipos/${eq1.id}`)
    await main(O).getByRole("button", { name: "Reservar", exact: true }).first().click()
    await main(O).getByText(/^Tuyo/).first().waitFor()
    await typeInTerminal(O, "UART1", "operador-escribe", true)
    await waitTerm(O, "UART1", /operador-escribe/, "lo que teclea el operador")
    await A.goto(`${BASE}/`)
    const card = main(A).getByRole("article", { name: EQ1 })
    await card.getByText(/Olga|O\. Operadora/).first().waitFor()
    await card.getByRole("button", { name: `Más acciones de ${EQ1}` }).click()
    await A.getByRole("menuitem", { name: "Forzar liberación…" }).click()
    const dlg = dialogWith(A, `¿Forzar la liberación de ${EQ1}?`)
    await dlg.waitFor()
    await dlg.getByRole("checkbox", { name: "Reservar para mí a continuación" }).uncheck()
    await dlg.getByRole("textbox", { name: "Motivo" }).fill("Prueba E2E de liberación forzada")
    await shot(A, "forzar-liberacion")
    await dlg.getByRole("button", { name: "Forzar liberación" }).click()
    await card.getByRole("button", { name: `Reservar ${EQ1}` }).waitFor()
    await main(O).getByText("Solo lectura. Reserva el equipo para escribir.").first().waitFor({ timeout: 15_000 })
    await shot(O, "operador-tras-forzar")
    return "el operador vuelve a solo lectura"
  })

  await step("10b", "Teclado: Mayús+Tab sale del terminal a la barra del panel", async () => {
    await A.goto(`${BASE}/equipos/${eq1.id}`)
    await pane(A, "UART0").waitFor()
    await pane(A, "UART0").locator(".xterm-helper-textarea").focus()
    await A.keyboard.press("Shift+Tab")
    const where = await A.evaluate(() => {
      const el = document.activeElement
      const tb = el?.closest("[role=toolbar]")
      return { tag: el?.tagName, label: el?.getAttribute("aria-label") ?? el?.textContent?.trim().slice(0, 40), toolbar: tb?.getAttribute("aria-label") ?? null }
    })
    assert(where.toolbar === "UART0 · UART0", `foco tras Mayús+Tab: ${JSON.stringify(where)}`)
    await shot(A, "teclado-shift-tab")
    return `foco en ${where.tag} «${where.label}» de la barra «${where.toolbar}»`
  })

  await step("10d", "Firefox: la consola por WebSocket funciona con la CSP de producción", async () => {
    const exe = firefoxPath()
    if (!exe) return "OMITIDO: no hay Firefox de Playwright (RM_E2E_FIREFOX)"
    const fx = await firefox.launch({ executablePath: exe, headless: !HEADED })
    try {
      const context = await fx.newContext({ viewport: null }) // no viewport emulation: works with older Playwright Firefox builds too
      await context.addInitScript(() => { try { localStorage.setItem("rm-term-sr", "1") } catch { /* private mode */ } })
      const page = await context.newPage()
      const errors = []
      page.on("pageerror", (e) => errors.push(e.message))
      page.on("console", (m) => { if (m.type() === "error" && /Content.Security|CSP/i.test(m.text())) errors.push(m.text()) })
      await uiLogin(page, ADMIN.username, ADMIN.password)
      await page.goto(`${BASE}/equipos/${eq1.id}`)
      await waitTerm(page, "UART0", /login:/, "«login:» en Firefox", 20_000)
      await waitFor(async () => /(Recibiendo|Sin datos)/.test(await paneStatus(page, "UART1")), { what: "estado de UART1 en Firefox" })
      await shot(page, "firefox-espacio")
      assert(!errors.length, `errores en Firefox: ${errors.join(" | ")}`)
      return `Firefox ${fx.version()}: historial y estado en directo por WebSocket, sin avisos de CSP`
    } finally {
      await fx.close()
    }
  })

  await step("10e", "Pantallas estrechas y anchas: menú a 390 px, sin desplazamiento horizontal a 1024 y 1440 px", async () => {
    const vp = A.viewportSize()
    try {
      await A.setViewportSize({ width: 390, height: 844 })
      await A.goto(`${BASE}/`)
      await A.getByRole("button", { name: "Abrir menú" }).waitFor()
      await A.getByRole("button", { name: "Abrir menú" }).click()
      await A.getByRole("link", { name: "Plantillas" }).first().waitFor()
      await shot(A, "menu-390")
      await A.keyboard.press("Escape")
      const out = []
      for (const width of [1024, 1440]) {
        await A.setViewportSize({ width, height: 900 })
        for (const id of [eq1.id, eq2Id]) {
          await A.goto(`${BASE}/equipos/${id}`)
          await main(A).getByRole("region", { name: "Consolas del equipo" }).waitFor()
          await sleep(500)
          const o = await A.evaluate(() => ({ doc: document.documentElement.scrollWidth, vw: window.innerWidth }))
          assert(o.doc <= o.vw, `desplazamiento horizontal a ${width} px en /equipos/${id}: ${o.doc} > ${o.vw}`)
          out.push(`${width}px ok`)
        }
      }
      await shot(A, "equipo2-1440")
      return out.join(", ")
    } finally {
      await A.setViewportSize(vp)
    }
  })

  await step("10c", "WebSocket: límite de sesiones por usuario y consola (4009)", async () => {
    const extra = []
    let code = null
    for (let i = 0; i < 6 && code === null; i++) {
      const w = openConsoleWs(api, consoles1.UART0)
      extra.push(w)
      await waitFor(() => w.msg("hello") || w.state.closeCode || w.state.httpStatus, { what: "hello o cierre" })
      if (w.state.closeCode) code = w.state.closeCode
    }
    for (const w of extra) await w.close()
    assert(code === 4009, `sesión de más: cierre ${code}`)
    return `cierre 4009 tras ${extra.length - 1} sesiones aceptadas`
  })

  await step("11", "Auditoría y eventos SSE", async () => {
    const page = await (await api.get("/api/audit?limit=200")).json()
    const rows = page.items ?? page.events ?? page.rows ?? page
    assert(Array.isArray(rows), `respuesta de /api/audit: ${JSON.stringify(page).slice(0, 200)}`)
    const count = (a) => rows.filter((r) => r.action === a).length
    const need = {
      "reservation.reserve": 1, "relay.set": 2, "relay.pulse": 1, "console.release": 1, "console.retake": 1,
      "reservation.release": 1, "reservation.force-release": 1, "equipment.create": 1, "template.reload": 1,
      "auth.login.ok": 1, "auth.setup.completed": 1, "auth.password.changed": 1, "console.session.open": 1, "console.log.download": 1,
      "cable.label.create": 1, "access.start": 3, "access.stop": 3, "access.connect": 2,
      "files.upload": 1, "files.download": 1, "files.rename": 1, "files.delete": 1,
    }
    const missing = Object.entries(need).filter(([a, n]) => count(a) < n).map(([a, n]) => `${a} (${count(a)}/${n})`)
    assert(!missing.length, `faltan en la auditoría: ${missing.join(", ")}`)
    const leaked = rows.filter((r) => JSON.stringify(r.detail ?? {}).match(/e2e-password|op-password|secreto-e2e/))
    assert(!leaked.length, `secretos en el detalle de la auditoría: ${leaked.map((r) => r.action).join(", ")}`)
    const types = new Set(ctx.sse.events.map((e) => e.type))
    for (const t of ["hello", "reservation.changed", "console.status", "relay.state", "equipment.changed", "access.status", "files.changed"]) {
      assert(types.has(t), `el SSE no ha recibido ${t} (tipos: ${[...types].join(", ")})`)
    }
    await A.goto(`${BASE}/auditoria`)
    await main(A).getByRole("heading", { name: "Auditoría", level: 1 }).waitFor()
    await main(A).getByText("Liberación forzada", { exact: false }).first().waitFor().catch(() => {})
    await shot(A, "auditoria")
    return `${rows.length} filas; SSE: ${[...types].join(", ")}`
  })

  await step("11b", "Desactivar al operador desde la CLI: su WebSocket se cierra (4010) y su reserva se libera en 30 s", async () => {
    await O.goto(`${BASE}/equipos/${eq2Id}`)
    await main(O).getByRole("button", { name: "Reservar", exact: true }).first().click()
    await main(O).getByText(/^Tuyo/).first().waitFor()
    assert(ctx.opWs.state.closeCode === null, "el WebSocket del operador ya estaba cerrado")
    const t = Date.now()
    const from = ctx.sse.events.length
    const r = await cli(["user", "disable", OPER.username], env)
    assert(r.code === 0, `user disable: ${r.stderr || r.stdout}`)
    await waitFor(() => ctx.opWs.state.closeCode, { timeout: 35_000, interval: 250, what: "el cierre del WebSocket del operador" })
    assert(ctx.opWs.state.closeCode === 4010, `cierre ${ctx.opWs.state.closeCode} (se esperaba 4010)`)
    const ev = await ctx.sse.waitFor((e) => ctx.sse.events.indexOf(e) >= from && e.type === "reservation.changed" && e.data.equipmentId === eq2Id && e.data.reservation === null, "reserva liberada", 35_000)
    assert(ev.data.cause === "user-removed", `causa de la liberación: ${ev.data.cause}`)
    const ms = Date.now() - t
    // The app navigates the tab twice (beforeunload guard, then /login): waitForURL can see an aborted frame, so poll.
    await waitFor(() => /\/login/.test(O.url()), { timeout: 35_000, what: "la pestaña del operador en /login" })
    await O.waitForLoadState("load").catch(() => {})
    await shot(O, "operador-desactivado")
    return `WS 4010 y reserva liberada (${ev.data.cause}) en ${(ms / 1000).toFixed(1)} s; su pestaña vuelve a /login`
  })

  await step("12", "Cerrar sesión: vuelve a /login en el mismo host", async () => {
    await A.getByRole("button", { name: /^Menú de usuario/ }).click()
    await A.getByRole("menuitem", { name: "Cerrar sesión" }).click()
    await A.waitForURL(/\/login/, { timeout: 20_000 })
    const u = new URL(A.url())
    assert(u.host === `127.0.0.1:${PORT}`, `host tras cerrar sesión: ${u.host}`)
    const res = await fetch(`${BASE}/`, { redirect: "manual", headers: { cookie: (await admin.context.cookies()).map((c) => `${c.name}=${c.value}`).join("; ") } })
    assert(res.status >= 300 && res.status < 400 && /\/login/.test(res.headers.get("location") ?? ""), `GET / tras cerrar sesión: ${res.status} ${res.headers.get("location")}`)
    const out = await api.logout()
    assert(out.loggedOut, "logout HTTP sin borrar la cookie")
    await shot(A, "sesion-cerrada")
    return `${u.href}; la cookie ya no abre /`
  })

  await step("13", "Errores del navegador y parada limpia", async () => {
    const errs = ctx.pages.flatMap((p) => p.errors.map((e) => `${p.name}: ${e}`))
    const authErrors = ctx.server.log().split("\n").filter((l) => l.includes("[auth][error]"))
    assert(!authErrors.length, `errores de Auth.js en el registro del servidor:\n${authErrors.join("\n")}`)
    for (const s of ctx.sockets) await s.close()
    ctx.sockets = []
    await ctx.sse.close()
    ctx.sse = null
    await ctx.browser.close()
    ctx.browser = null
    const stopped = await ctx.server.stop()
    ctx.server = null
    assert(stopped.code === 0 && stopped.ms < 8000, `SIGTERM: ${JSON.stringify(stopped)}`)
    assert(!fs.existsSync(path.join(dataDir, "server.pid")), "server.pid sigue existiendo tras la parada")
    assert(!errs.length, `errores en el navegador:\n${errs.join("\n")}`)
    return `SIGTERM → salida 0 en ${stopped.ms} ms; sin errores en la consola del navegador`
  })
}

let exitCode = 0
const onSignal = () => { cleanup().finally(() => process.exit(130)) }
process.on("SIGINT", onSignal)
process.on("SIGTERM", onSignal)
try {
  await run()
  say(`\u001b[1;32m==>\u001b[0m Prueba E2E superada: ${results.length} pasos en ${Math.round((Date.now() - t0) / 1000)} s; capturas en ${path.relative(REPO, SHOTS)}/`)
} catch (err) {
  exitCode = 1
  if (ctx.server) {
    const log = ctx.server.log().split("\n").slice(-40).join("\n")
    say(`--- Últimas líneas del servidor ---\n${log}`)
  }
  if (!(err instanceof StepError)) say(String(err?.stack ?? err))
} finally {
  writeResults(exitCode === 0)
  await cleanup()
}
process.exit(exitCode)
