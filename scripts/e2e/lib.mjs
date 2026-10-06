// Helpers of the E2E smoke test (§11.4, W3-I): processes, the fake bench, HTTP/WS clients and small waits.
// Plain ESM with no dependency beyond the repo's own devDependencies (ws, playwright-core).
import { spawn } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { parseEnv } from "node:util"
import WebSocket from "ws"
import { startBench } from "../sim/bench.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const REPO = path.resolve(HERE, "..", "..")
/** The generic sample profile of the repo: the default of the E2E test. */
export const EXAMPLE_PROFILE = path.join(REPO, "examples", "perfil-ejemplo")
/** Fake download script (same contract as a profile's: <app> <version> -o <zip> [-x]; "fail" fails), no network. */
export const FAKE_DOWNLOADER = path.join(REPO, "test", "fixtures", "fake-export-downloader.sh")

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export { sleep }

export class StepError extends Error {}

/** Polls `fn` until it returns a truthy value (returned) or the timeout expires (throws with `what`). */
export async function waitFor(fn, { timeout = 10_000, interval = 200, what = "condición" } = {}) {
  const end = Date.now() + timeout
  let last
  for (;;) {
    try {
      const v = await fn()
      if (v) return v
    } catch (e) {
      last = e
    }
    if (Date.now() > end) throw new StepError(`Tiempo agotado esperando: ${what}${last ? ` (${last.message})` : ""}`)
    await sleep(interval)
  }
}

export function assert(cond, msg) {
  if (!cond) throw new StepError(msg)
}

/** Resolves when nothing listens on host:port (so a fixed port from the spec is usable). */
export function portIsFree(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const s = net.createServer()
    s.once("error", () => resolve(false))
    s.listen(port, host, () => s.close(() => resolve(true)))
  })
}

export function randomPort(min = 20_000, span = 20_000) {
  return min + Math.floor(Math.random() * span)
}

export function makeTempDir(prefix = "rm-e2e-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

// ---------------------------------------------------------------------------------------------------------------
// Project profile («perfil»): perfil.env and plantillas/*.json, read the way the app reads them.

/**
 * Loads a profile folder: { dir, env (perfil.env, dotenv), templates (plantillas/*.json at the top level, not "." or "_"
 * names, by position; each with `file`), example (it is examples/perfil-ejemplo) }. Invalid JSON throws (the run needs
 * a valid profile; `relay-manager plantillas comprobar` explains the details).
 */
export function loadProfile(dir) {
  const abs = path.resolve(dir)
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw new StepError(`No existe la carpeta del perfil ${abs}`)
  const envFile = path.join(abs, "perfil.env")
  const env = fs.existsSync(envFile) ? { ...parseEnv(fs.readFileSync(envFile, "utf8")) } : {}
  const templates = []
  const tdir = path.join(abs, "plantillas")
  for (const f of fs.existsSync(tdir) ? fs.readdirSync(tdir).sort() : []) {
    if (!f.endsWith(".json") || f.startsWith(".") || f.startsWith("_")) continue
    let t
    try {
      t = JSON.parse(fs.readFileSync(path.join(tdir, f), "utf8"))
    } catch (e) {
      throw new StepError(`${path.join(abs, "plantillas", f)}: JSON no válido (${e.message})`)
    }
    templates.push({ ...t, file: `plantillas/${f}` })
  }
  templates.sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
  const example = fs.existsSync(EXAMPLE_PROFILE) && fs.realpathSync(abs) === fs.realpathSync(EXAMPLE_PROFILE)
  return { dir: abs, env, templates, example }
}

/**
 * The template the wizard steps use: 2 consoles, no relays and 5 accesses in this order — JTAG, JTAG, serial of
 * console 1, serial of console 2, Ethernet through the switch (the example profile's «Equipo con 2 consolas» is one).
 */
export function pickWizardTemplate(profile) {
  const fits = (t) => {
    const c = t.consoles ?? []
    const a = t.accesses ?? []
    return c.length === 2 && (t.relays ?? []).length === 0 && a.length === 5
      && a[0].kind === "jtag" && a[1].kind === "jtag"
      && a[2].kind === "serial" && a[2].consoleKey === c[0].key && a[3].kind === "serial" && a[3].consoleKey === c[1].key
      && a[4].kind === "tcp" && a[4].targetMode === "switch"
  }
  const t = profile.templates.find(fits)
  if (!t) {
    throw new StepError(`El perfil ${profile.dir} no tiene una plantilla para el asistente de la prueba: 2 consolas, sin relés y 5 accesos `
      + "(JTAG, JTAG, serie de la consola 1, serie de la consola 2, Ethernet por el switch), como «Equipo con 2 consolas» de examples/perfil-ejemplo")
  }
  return t
}

/** Same rule as formatEquipmentName (src/lib/contracts/templates.ts): the pattern with number `i`. */
export function equipmentName(pattern, templateName, i) {
  const base = pattern.replaceAll("{template}", templateName).replaceAll("{nnn}", String(i).padStart(3, "0"))
    .replaceAll("{nn}", String(i).padStart(2, "0")).replaceAll("{n}", String(i))
  return /\{n{1,3}\}/.test(pattern) || i === 1 ? base : `${base} (${i})`
}

/** A console key as a host name part: "UART0" → "uart0", "CONSOLA_1" → "consola-1". */
export const hostPart = (key) => key.toLowerCase().replace(/[^a-z0-9]+/g, "-")

/** Escapes a literal for a RegExp. */
export const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

// ---------------------------------------------------------------------------------------------------------------
// Fake bench (scripts/sim/bench.mjs) with a bench config written for this run.

/**
 * Starts 4 fake Zynq consoles (ttyV0..ttyV3 in `simDir`) and one dS378 with ASCII + UDP on `relayHost`. `hosts`: the
 * host names of the 4 consoles (ttyV0/1: the imported unit, ttyV2/3: the one the wizard creates).
 * Returns the bench handle of `startBench` plus the relay settings.
 */
export async function startFakeBench({ dir, simDir, relayHost, asciiPort, httpPort, udpPort, hosts, quiet = true }) {
  const cfg = {
    simDir,
    consoles: [
      { link: "ttyV0", stage: "boot", host: hosts[0], autoboot: 1, speed: 0.2 },
      { link: "ttyV1", stage: "login", host: hosts[1] },
      { link: "ttyV2", stage: "shell", host: hosts[2] },
      { link: "ttyV3", stage: "login", host: hosts[3] },
    ],
    relays: [
      { model: "dS378", host: relayHost, http: httpPort, ascii: asciiPort, udp: true, udpPort, replyTo: "127.255.255.255", mac: "00:04:a3:00:00:01" },
    ],
  }
  const file = path.join(dir, "bench.json")
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2))
  const sink = quiet ? fs.createWriteStream(path.join(dir, "bench.log")) : process.stdout
  const bench = await startBench({ configFile: file, stdout: sink, stderr: sink, log: (l) => sink.write(`${l}\n`) })
  if (!bench.links.length) throw new StepError("python3 no está disponible: la prueba necesita las consolas simuladas")
  await waitFor(() => bench.links.every((l) => fs.existsSync(l)), { timeout: 10_000, what: "los pty simulados" })
  await waitFor(() => asciiCommand(relayHost, asciiPort, "ST").then(() => true), { timeout: 10_000, what: "el simulador dS378" })
  return { ...bench, cfg, sink }
}

/** One dS ASCII command ("GR 1", "ST"…) against the simulator; resolves with the reply line. */
export function asciiCommand(host, port, cmd, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host, port })
    let buf = ""
    const t = setTimeout(() => { s.destroy(); reject(new Error(`sin respuesta a ${cmd}`)) }, timeout)
    s.on("connect", () => s.write(`${cmd}\r\n`))
    s.on("data", (d) => {
      buf += d.toString("latin1")
      if (/\r?\n/.test(buf)) { clearTimeout(t); s.end(); resolve(buf.trim()) }
    })
    s.on("error", (e) => { clearTimeout(t); reject(e) })
  })
}

/** "fake: kill and restart the pty" (§14): restarts one fake Zynq console, which creates a new pty behind the link. */
export async function replugConsole(bench, link) {
  const idx = bench.cfg.consoles.findIndex((c) => c.link === link)
  const entry = bench.children[idx]
  const old = entry.ch
  const target = fs.realpathSync(path.join(bench.simDir, link))
  await new Promise((resolve) => { old.once("exit", resolve); old.kill("SIGTERM") })
  await waitFor(() => !fs.existsSync(path.join(bench.simDir, link)), { timeout: 5000, what: `que desaparezca ${link}` })
  const c = bench.cfg.consoles[idx]
  const args = [path.join(REPO, "scripts", "sim", "fake-zynq.py"), "--link", path.join(bench.simDir, link), "--stage", c.stage, "--host", c.host]
  const ch = spawn("python3", args, { stdio: ["ignore", "pipe", "pipe"] })
  ch.stdout.pipe(bench.sink, { end: false })
  ch.stderr.pipe(bench.sink, { end: false })
  bench.children[idx] = { name: entry.name, ch }
  await waitFor(() => fs.existsSync(path.join(bench.simDir, link)), { timeout: 5000, what: `que reaparezca ${link}` })
  return { oldTarget: target, newTarget: fs.realpathSync(path.join(bench.simDir, link)) }
}

/** Stops every bench child (including replugged ones) and removes the links. */
export async function stopFakeBench(bench) {
  if (!bench) return
  await bench.stop()
  for (const { ch } of bench.children) if (ch.exitCode === null && ch.signalCode === null) ch.kill("SIGKILL")
}

// ---------------------------------------------------------------------------------------------------------------
// Server and CLI (node build/server.js, portable mode, app dir = the repo with its .next build).

/**
 * The environment of the server under test. The profile's values stay in its perfil.env (the app reads them); only
 * what a test machine must never use comes from here: the folders (never the real ~/tftp or ~/<extra> of whoever runs
 * the tests), and, when the profile lacks them, a second folder («Compartida»), the download script (the fake one;
 * also for a project profile, whose script needs its network, unless RM_E2E_REAL_DOWNLOADER=1) and the equipment IP.
 */
export function serverEnv({ dataDir, port, profile, extra = {} }) {
  const env = { ...process.env }
  const realDownloader = env.RM_E2E_REAL_DOWNLOADER === "1"
  for (const k of Object.keys(env)) if (k.startsWith("RM_") || k === "AUTH_URL" || k === "NEXTAUTH_URL") delete env[k]
  const cfgFile = path.join(dataDir, "..", "config.env")
  if (!fs.existsSync(cfgFile)) fs.writeFileSync(cfgFile, "# E2E: todo por entorno\n")
  const p = profile.env
  const own = {}
  if (!p.RM_FILES_EXTRA_NAME || p.RM_FILES_EXTRA_ENABLED === "0") Object.assign(own, { RM_FILES_EXTRA_NAME: "Compartida", RM_FILES_EXTRA_ENABLED: "1" })
  if (p.RM_EXPORT_ENABLED !== "1" || !p.RM_EXPORT_DOWNLOADER || (!profile.example && !realDownloader)) {
    Object.assign(own, { RM_EXPORT_ENABLED: "1", RM_EXPORT_DOWNLOADER: FAKE_DOWNLOADER })
  }
  if (!p.RM_EQUIPNET_EQUIPMENT_IP) own.RM_EQUIPNET_EQUIPMENT_IP = "192.168.1.10"
  return {
    ...env,
    NODE_ENV: "production",
    NEXT_TELEMETRY_DISABLED: "1",
    RM_MODE: "portable",
    RM_APP_DIR: REPO,
    RM_DATA_DIR: dataDir,
    RM_PROFILE_DIR: profile.dir,
    // Never the real ~/tftp nor ~/<second folder> of whoever runs the tests.
    RM_FILES_DIR: path.join(dataDir, "..", "tftp"),
    RM_FILES_EXTRA_DIR: path.join(dataDir, "..", "extra"),
    ...own,
    RM_CONFIG: cfgFile,
    RM_PORT: String(port),
    RM_HOST: "127.0.0.1",
    RM_LOG_LEVEL: "info",
    ...extra,
  }
}

/** Runs `node build/server.js <args>`; resolves { code, stdout, stderr }. */
export function cli(args, env, input = null) {
  return new Promise((resolve) => {
    const ch = spawn(process.execPath, [path.join(REPO, "build", "server.js"), ...args], { env, stdio: ["pipe", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    ch.stdout.on("data", (d) => (stdout += d))
    ch.stderr.on("data", (d) => (stderr += d))
    ch.on("close", (code) => resolve({ code, stdout, stderr }))
    if (input !== null) ch.stdin.end(input)
    else ch.stdin.end()
  })
}

/** Starts the server and waits for /api/health. Returns { child, base, pid, log(), stop() }. */
export async function startServer({ env, logFile }) {
  const out = fs.openSync(logFile, "a")
  const child = spawn(process.execPath, [path.join(REPO, "build", "server.js"), "start"], { env, stdio: ["ignore", out, out] })
  fs.closeSync(out)
  const base = `http://127.0.0.1:${env.RM_PORT}`
  let exited = null
  child.once("exit", (code, signal) => (exited = { code, signal }))
  await waitFor(async () => {
    if (exited) throw new StepError(`El servidor terminó al arrancar (${JSON.stringify(exited)}); ver ${logFile}`)
    const r = await fetch(`${base}/api/health`)
    return r.ok
  }, { timeout: 60_000, interval: 300, what: "que el servidor responda en /api/health" })
  return {
    child,
    base,
    pid: child.pid,
    log: () => fs.readFileSync(logFile, "utf8"),
    async stop(timeoutMs = 8000) {
      if (exited) return exited
      const t0 = Date.now()
      const done = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })))
      child.kill("SIGTERM")
      const t = setTimeout(() => child.kill("SIGKILL"), timeoutMs)
      const r = await done
      clearTimeout(t)
      return { ...r, ms: Date.now() - t0 }
    },
  }
}

/** Every link under /proc/<pid>/fd that resolves to `target` (a pty). */
export function fdsPointingAt(pid, target) {
  const dir = `/proc/${pid}/fd`
  const hits = []
  for (const fd of fs.readdirSync(dir)) {
    try {
      if (fs.readlinkSync(path.join(dir, fd)) === target) hits.push(fd)
    } catch { /* closed meanwhile */ }
  }
  return hits
}

// ---------------------------------------------------------------------------------------------------------------
// HTTP session (cookie jar of one user) for the API, SSE and WS checks.

export class HttpSession {
  constructor(base) {
    this.base = base
    this.jar = new Map()
  }
  cookie() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ")
  }
  absorb(res) {
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(";")
      const i = pair.indexOf("=")
      const name = pair.slice(0, i).trim()
      const value = pair.slice(i + 1).trim()
      if (!value || /Max-Age=0/i.test(c) || /Expires=Thu, 01 Jan 1970/i.test(c)) this.jar.delete(name)
      else this.jar.set(name, value)
    }
  }
  async get(p, init = {}) {
    const res = await fetch(`${this.base}${p}`, { redirect: "manual", ...init, headers: { cookie: this.cookie(), ...(init.headers ?? {}) } })
    this.absorb(res)
    return res
  }
  async post(p, body, { origin = this.base, headers = {} } = {}) {
    const h = { cookie: this.cookie(), ...headers }
    if (origin) h.origin = origin
    let payload = body
    if (body instanceof URLSearchParams) {
      h["content-type"] = "application/x-www-form-urlencoded"
      payload = body.toString()
    }
    const res = await fetch(`${this.base}${p}`, { method: "POST", redirect: "manual", headers: h, body: payload })
    this.absorb(res)
    return res
  }
  /** NextAuth csrf + credentials. Returns true when a session cookie was set. */
  async login(username, password) {
    const csrf = await (await this.get("/api/auth/csrf")).json()
    const res = await this.post("/api/auth/callback/credentials", new URLSearchParams({ csrfToken: csrf.csrfToken, username, password, callbackUrl: `${this.base}/` }))
    return { status: res.status, location: res.headers.get("location"), ok: [...this.jar.keys()].some((k) => k.includes("session-token")) }
  }
  async logout() {
    const csrf = await (await this.get("/api/auth/csrf")).json()
    const res = await this.post("/api/auth/signout", new URLSearchParams({ csrfToken: csrf.csrfToken, callbackUrl: `${this.base}/login` }))
    return { status: res.status, location: res.headers.get("location"), loggedOut: ![...this.jar.keys()].some((k) => k.includes("session-token")) }
  }
}

/** Opens /api/events and collects parsed events until `close()`. */
export async function openSse(session, p = "/api/events") {
  const ctrl = new AbortController()
  const res = await fetch(`${session.base}${p}`, { headers: { cookie: session.cookie(), accept: "text/event-stream" }, signal: ctrl.signal })
  if (!res.ok || !res.body) throw new StepError(`SSE ${p}: HTTP ${res.status}`)
  const events = []
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ""
  let closed = false
  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let i
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i)
          buf = buf.slice(i + 2)
          let type = "message"
          const data = []
          for (const line of block.split("\n")) {
            if (line.startsWith("event:")) type = line.slice(6).trim()
            else if (line.startsWith("data:")) data.push(line.slice(5).trimStart())
          }
          if (!data.length) continue
          let parsed = data.join("\n")
          try { parsed = JSON.parse(parsed) } catch { /* plain text */ }
          // The server frames every event as `data: {"type": …}` (no `event:` line).
          if (type === "message" && parsed && typeof parsed === "object" && typeof parsed.type === "string") type = parsed.type
          events.push({ type, data: parsed })
        }
      }
    } catch { /* aborted */ }
    closed = true
  })()
  return {
    events,
    get closed() { return closed },
    find: (pred) => events.find(pred),
    waitFor: (pred, what, timeout = 10_000) => waitFor(() => events.find(pred), { timeout, what: `evento SSE ${what}` }),
    close: async () => { ctrl.abort(); await pump },
  }
}

/** Opens /ws/console/<id>. Collects JSON messages and binary output; resolves once open (or with the close code). */
export function openConsoleWs(session, consoleId, { origin = session.base } = {}) {
  const url = `${session.base.replace(/^http/, "ws")}/ws/console/${consoleId}`
  const headers = { cookie: session.cookie() }
  if (origin) headers.origin = origin
  const ws = new WebSocket(url, { headers })
  const messages = []
  const chunks = []
  const state = { closeCode: null, httpStatus: null, open: false }
  ws.on("message", (data, isBinary) => {
    if (isBinary) chunks.push(Buffer.from(data))
    else {
      try { messages.push(JSON.parse(data.toString())) } catch { /* ignore */ }
    }
  })
  ws.on("close", (code) => (state.closeCode = code))
  ws.on("unexpected-response", (_req, res) => { state.httpStatus = res.statusCode; ws.terminate() })
  ws.on("error", () => { /* reported through close/unexpected-response */ })
  const api = {
    ws,
    messages,
    state,
    text: () => Buffer.concat(chunks).toString("utf8"),
    msg: (t) => messages.find((m) => m.t === t),
    waitMsg: (pred, what, timeout = 10_000) => waitFor(() => messages.find(pred), { timeout, what: `mensaje WS ${what}` }),
    waitText: (re, what, timeout = 10_000) => waitFor(() => re.test(Buffer.concat(chunks).toString("utf8")), { timeout, what: `texto ${what}` }),
    waitClosed: (timeout = 10_000) => waitFor(() => state.closeCode ?? state.httpStatus, { timeout, what: "cierre del WebSocket" }),
    send: (s) => ws.send(Buffer.from(s, "utf8"), { binary: true }),
    close: () => new Promise((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) return resolve()
      ws.once("close", () => resolve())
      ws.close()
    }),
  }
  return api
}
