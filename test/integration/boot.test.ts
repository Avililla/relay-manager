// Boot integration test (§11.3, W3-I). Runs the real `start()` (the esbuild server, `node build/server.js start`)
// against a temp data dir with RM_PORT=0, one fake Zynq pty (scripts/sim/fake-zynq.py) found through
// RM_SERIAL_EXTRA_GLOBS and one Devantech simulator on random ports, then drives the whole stack over the wire:
// health, first-run setup with the token (the real server action), credentials login (csrf dance), SSE, the console
// WebSocket (history, read-only, reserve → read-write, typed data), a relay set verified on the simulator, release,
// and a clean SIGTERM shutdown.
//
// It needs a production build (`pnpm build`: build/server.js and .next/) and python3; without them it is skipped, so
// `pnpm test` stays green on a fresh checkout and inside `pnpm bundle` (which runs the tests before building).
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import WebSocket from "ws"
import { createSimulator, type Simulator } from "../../scripts/sim/devantech-sim.mjs"

const REPO = path.resolve(__dirname, "..", "..")
const SERVER = path.join(REPO, "build", "server.js")
const MANIFEST = path.join(REPO, ".next", "server", "server-reference-manifest.json")
const hasBuild = fs.existsSync(SERVER) && fs.existsSync(path.join(REPO, ".next", "required-server-files.json")) && fs.existsSync(MANIFEST)
const hasPython = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0

const TOKEN = "BOOT-TEST-TOKEN-0001"
const ADMIN = { username: "admin", name: "Admin Integración", password: "boot-password-1" }

interface ActionManifest { node: Record<string, { exportedName?: string; workers: Record<string, unknown> }> }

/** Server action id by exported name (the production build's manifest). */
function actionId(name: string): string {
  const m = JSON.parse(fs.readFileSync(MANIFEST, "utf8")) as ActionManifest
  const hit = Object.entries(m.node).find(([, v]) => v.exportedName === name)
  if (!hit) throw new Error(`Acción ${name} no encontrada en ${MANIFEST}`)
  return hit[0]
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitFor<T>(fn: () => T | Promise<T>, what: string, timeout = 10_000): Promise<NonNullable<T>> {
  const end = Date.now() + timeout
  for (;;) {
    try {
      const v = await fn()
      if (v) return v as NonNullable<T>
    } catch { /* retry */ }
    if (Date.now() > end) throw new Error(`Tiempo agotado esperando: ${what}`)
    await sleep(100)
  }
}

/** A cookie jar for one user. Every POST carries `Origin` (the Origin gate refuses it otherwise). */
class Client {
  readonly jar = new Map<string, string>()
  constructor(readonly base: string) {}
  cookie(): string {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ")
  }
  private absorb(res: Response): void {
    for (const c of res.headers.getSetCookie()) {
      const pair = c.split(";")[0]
      const i = pair.indexOf("=")
      const name = pair.slice(0, i).trim()
      const value = pair.slice(i + 1).trim()
      if (!value || /Max-Age=0/i.test(c)) this.jar.delete(name)
      else this.jar.set(name, value)
    }
  }
  async get(p: string): Promise<Response> {
    const res = await fetch(`${this.base}${p}`, { redirect: "manual", headers: { cookie: this.cookie() } })
    this.absorb(res)
    return res
  }
  async post(p: string, body: string, headers: Record<string, string>): Promise<Response> {
    const res = await fetch(`${this.base}${p}`, { method: "POST", redirect: "manual", body, headers: { origin: this.base, cookie: this.cookie(), ...headers } })
    this.absorb(res)
    return res
  }
  /** Calls a server action the way the browser does, from `page`; returns the action's result object. */
  async action<T>(page: string, name: string, input: unknown): Promise<T> {
    const res = await this.post(page, JSON.stringify([input]), { "next-action": actionId(name), accept: "text/x-component", "content-type": "text/plain;charset=UTF-8" })
    const text = await res.text()
    if (res.status !== 200) throw new Error(`${name}: HTTP ${res.status} ${text.slice(0, 200)}`)
    // RSC payload: the action's return value is the row "1:{…}".
    const row = text.split("\n").find((l) => l.startsWith("1:"))
    if (!row) throw new Error(`${name}: respuesta sin resultado: ${text.slice(0, 300)}`)
    return JSON.parse(row.slice(2)) as T
  }
  async login(username: string, password: string): Promise<boolean> {
    const csrf = (await (await this.get("/api/auth/csrf")).json()) as { csrfToken: string }
    const body = new URLSearchParams({ csrfToken: csrf.csrfToken, username, password, callbackUrl: `${this.base}/` })
    await this.post("/api/auth/callback/credentials", body.toString(), { "content-type": "application/x-www-form-urlencoded" })
    return [...this.jar.keys()].some((k) => k.includes("session-token"))
  }
}

type ActionResult<T = unknown> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } }
type WsMsg = { t: string; [k: string]: unknown }

function consoleSocket(client: Client, consoleId: string) {
  const ws = new WebSocket(`${client.base.replace(/^http/, "ws")}/ws/console/${consoleId}`, { headers: { cookie: client.cookie(), origin: client.base } })
  const messages: WsMsg[] = []
  const chunks: Buffer[] = []
  let closeCode: number | null = null
  ws.on("message", (data, isBinary) => {
    if (isBinary) chunks.push(Buffer.from(data as Buffer))
    else messages.push(JSON.parse(String(data)) as WsMsg)
  })
  ws.on("close", (code) => (closeCode = code))
  ws.on("error", () => {})
  return {
    ws,
    messages,
    text: () => Buffer.concat(chunks).toString("utf8"),
    closeCode: () => closeCode,
    waitMsg: (pred: (m: WsMsg) => boolean, what: string) => waitFor(() => messages.find(pred), `WS ${what}`),
    close: () => new Promise<void>((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) return resolve()
      ws.once("close", () => resolve())
      ws.close()
    }),
  }
}

describe.skipIf(!hasBuild || !hasPython)("boot (integration, servidor real)", () => {
  let tmp = ""
  let dataDir = ""
  let sim: Simulator
  let zynq: ChildProcess
  let server: ChildProcess
  let serverExit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  let base = ""
  let log = ""
  const env: NodeJS.ProcessEnv = { NODE_ENV: "production" }
  const admin = { client: null as unknown as Client }
  const ids = { equipment: "", console: "", channel: "" }

  const cli = (args: string[], input?: string) =>
    spawnSync(process.execPath, [SERVER, ...args], { env, input, encoding: "utf8", timeout: 30_000 })

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rm-boot-"))
    dataDir = path.join(tmp, "data")
    const simDir = path.join(dataDir, "sim")
    fs.mkdirSync(simDir, { recursive: true, mode: 0o750 })

    // One fake Zynq console already at its login prompt, and one dS378 on random ports.
    const link = path.join(simDir, "ttyV0")
    zynq = spawn("python3", [path.join(REPO, "scripts", "sim", "fake-zynq.py"), "--link", link, "--stage", "login", "--host", "boot-zynq"], { stdio: "ignore" })
    sim = await createSimulator({ model: "dS378", host: "127.0.0.1", http: 0, ascii: 0, log: false })
    await waitFor(() => fs.existsSync(link), "el pty simulado")

    for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("RM_") && k !== "NODE_ENV") env[k] = v
    Object.assign(env, {
      RM_MODE: "portable",
      RM_APP_DIR: REPO,
      RM_DATA_DIR: dataDir,
      RM_FILES_DIR: path.join(tmp, "tftp"),
      RM_CONFIG: path.join(tmp, "config.env"),
      RM_HOST: "127.0.0.1",
      RM_PORT: "0",
      RM_LOG_LEVEL: "info",
      RM_SETUP_TOKEN: TOKEN,
      RM_SERIAL_EXTRA_GLOBS: `${simDir}/ttyV*`,
      RM_RELAY_SIMULATE: "0",
      RM_RELAY_PASSIVE_DISCOVERY: "0",
      RM_RELAY_DISCOVERY_PORT: String(40_000 + Math.floor(Math.random() * 20_000)),
    })
    fs.writeFileSync(env.RM_CONFIG as string, "")

    // DB + one unit (console on the pty, one relay on the simulator), imported before the first start.
    expect(cli(["migrate"]).status).toBe(0)
    const fixture = {
      format: "relay-manager-config", version: 1, exportedAt: new Date().toISOString(), appVersion: "2.0.0",
      settings: { labName: "Laboratorio", bannerText: null }, roles: [], templates: [],
      boards: [{ name: "Placa de prueba", driver: "devantech-ds-ascii", host: "127.0.0.1", httpPort: sim.ports.http, tcpPort: sim.ports.ascii,
        model: "dS378", moduleId: 35, mac: sim.mac, relayCount: 8, options: {}, username: null, enabled: true, hasPassword: false }],
      equipment: [{
        name: "Unidad de arranque", serialNumber: null, description: null, templateName: null, roles: [],
        consoles: [{ key: "UART0", label: "UART0", line: { baudRate: 115200, dataBits: 8, parity: "none", stopBits: 1, flowControl: "none" },
          enterMode: "cr", localEcho: false, hupcl: false, captureToDisk: true, identify: {},
          binding: { matchBy: "path", bindingKey: `virtual:${link}`, byId: null, byPath: null, usbVendorId: null, usbProductId: null, usbSerial: null,
            usbInterface: null, usbPortNumber: null, usbIdPath: null, devicePath: link, adapterLabel: "ttyV0 (virtual)", lastDevNode: link } }],
        relays: [{ key: "POWER", label: "Alimentación", purpose: "power", requireConfirm: false, defaultPulseMs: null, boardName: "Placa de prueba", channel: 3 }],
      }],
    }
    const fixtureFile = path.join(tmp, "fixture.json")
    fs.writeFileSync(fixtureFile, JSON.stringify(fixture))
    const imp = cli(["config", "import", fixtureFile])
    expect(imp.stderr).toBe("")
    expect(imp.status).toBe(0)

    server = spawn(process.execPath, [SERVER, "start"], { env, stdio: ["ignore", "pipe", "pipe"] })
    server.stdout?.on("data", (d: Buffer) => (log += d.toString()))
    server.stderr?.on("data", (d: Buffer) => (log += d.toString()))
    serverExit = new Promise((resolve) => server.once("exit", (code, signal) => resolve({ code, signal })))
    const port = await waitFor(() => /Servidor escuchando .*puerto=(\d+)/.exec(log)?.[1], "el puerto del servidor", 60_000)
    base = `http://127.0.0.1:${port}`
    admin.client = new Client(base)
  }, 90_000)

  afterAll(async () => {
    if (server && server.exitCode === null && server.signalCode === null) {
      server.kill("SIGKILL")
      await serverExit
    }
    await sim?.stop()
    if (zynq && zynq.exitCode === null) {
      const gone = new Promise((r) => zynq.once("exit", r))
      zynq.kill("SIGTERM")
      await gone
    }
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  }, 30_000)

  it("GET /api/health → {ok:true, version}", async () => {
    const res = await fetch(`${base}/api/health`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(["ok", "version"])
    expect(body.ok).toBe(true)
    expect(log).toContain(TOKEN)
    expect(fs.existsSync(path.join(dataDir, "setup-token"))).toBe(true)
  })

  it("completes setup with the token (completeSetup) and ends setup", async () => {
    const anon = new Client(base)
    expect((await anon.get("/")).headers.get("location")).toMatch(/\/setup$/)
    const input = { token: "WRONG-TOKEN-0000-0000", username: ADMIN.username, name: ADMIN.name, password: ADMIN.password, passwordConfirm: ADMIN.password }
    const bad = await anon.action<ActionResult>("/setup", "completeSetup", input)
    expect(bad.ok).toBe(false)
    const good = await anon.action<ActionResult>("/setup", "completeSetup", { ...input, token: TOKEN.toLowerCase() })
    expect(good).toMatchObject({ ok: true })
    const again = await anon.action<ActionResult>("/setup", "completeSetup", { ...input, username: "otro", token: TOKEN })
    expect(again).toMatchObject({ ok: false, error: { code: "SETUP_DONE" } })
    expect(fs.existsSync(path.join(dataDir, "setup-token"))).toBe(false)
    expect((await anon.get("/setup")).headers.get("location")).toMatch(/\/login$/)
  })

  it("logs in through /api/auth/callback/credentials (csrf dance) and gets a session cookie", async () => {
    expect(await new Client(base).login(ADMIN.username, "wrong-password-1")).toBe(false)
    expect(await admin.client.login(ADMIN.username, ADMIN.password)).toBe(true)
    const home = await admin.client.get("/")
    expect(home.status).toBe(200)
    // A POST without Origin never reaches NextAuth or an action.
    const noOrigin = await fetch(`${base}/api/auth/signout`, { method: "POST", headers: { cookie: admin.client.cookie() }, redirect: "manual" })
    expect(noOrigin.status).toBe(403)
    const rows = cli(["user", "list"])
    expect(rows.stdout).toContain(ADMIN.username)
  })

  it("receives the SSE hello on /api/events", async () => {
    const ctrl = new AbortController()
    const res = await fetch(`${base}/api/events`, { headers: { cookie: admin.client.cookie() }, signal: ctrl.signal })
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    const reader = res.body!.getReader()
    let buf = ""
    const hello = await waitFor(async () => {
      const { value } = await reader.read()
      buf += new TextDecoder().decode(value)
      const line = buf.split("\n").find((l) => l.startsWith("data:") && l.includes('"hello"'))
      return line ? (JSON.parse(line.slice(5)) as { type: string; serverNow: string }) : null
    }, "SSE hello")
    expect(hello.type).toBe("hello")
    expect(Date.parse(hello.serverNow)).toBeGreaterThan(0)
    ctrl.abort()
    await reader.cancel().catch(() => {})
  })

  it("opens /ws/console/<id>: hello, history replay, history-end; read-only until reserved, then writes", async () => {
    // Ids straight from the DB (read-only; WAL lets the server keep writing).
    const Database = (await import("better-sqlite3")).default
    const db = new Database(path.join(dataDir, "relay-manager.db"), { readonly: true })
    try {
      const eq = db.prepare("SELECT id FROM Equipment WHERE name = ?").get("Unidad de arranque") as { id: string }
      ids.equipment = eq.id
      ids.console = (db.prepare("SELECT id FROM SerialConsole WHERE equipmentId = ?").get(eq.id) as { id: string }).id
      ids.channel = (db.prepare("SELECT id FROM RelayChannel WHERE equipmentId = ?").get(eq.id) as { id: string }).id
    } finally {
      db.close()
    }
    await waitFor(() => /Consola abierta consola=UART0/.test(log), "que el servidor abra la consola")

    // Unknown console and missing session.
    const unknown = consoleSocket(admin.client, "cnotarealconsole000000000")
    await waitFor(() => unknown.closeCode(), "cierre 4004")
    expect(unknown.closeCode()).toBe(4004)
    const anon = consoleSocket(new Client(base), ids.console)
    await waitFor(() => anon.closeCode(), "cierre 4001")
    expect(anon.closeCode()).toBe(4001)

    const s = consoleSocket(admin.client, ids.console)
    const hello = await s.waitMsg((m) => m.t === "hello", "hello")
    expect(hello).toMatchObject({ kind: "console", key: "UART0", mode: "ro", protocol: 1 })
    await s.waitMsg((m) => m.t === "history-end", "history-end")
    expect(s.messages.findIndex((m) => m.t === "hello")).toBeLessThan(s.messages.findIndex((m) => m.t === "history-end"))

    // Read-only: input is rejected and never reaches the console.
    s.ws.send(Buffer.from("root\r"), { binary: true })
    const rej = await s.waitMsg((m) => m.t === "input-rejected", "input-rejected")
    expect(rej.reason).toBe("not-holder")

    // Reserve (server action from the workspace page) → the open socket switches to read-write.
    const r = await admin.client.action<ActionResult>(`/equipos/${ids.equipment}`, "reserveEquipment", { equipmentId: ids.equipment, note: null })
    expect(r).toMatchObject({ ok: true })
    await s.waitMsg((m) => m.t === "mode" && m.mode === "rw", "modo rw")
    s.ws.send(Buffer.from("\r"), { binary: true })
    await waitFor(() => /boot-zynq login:/.test(s.text()), "el prompt de login")
    s.ws.send(Buffer.from("root\r"), { binary: true })
    await waitFor(() => /Password:/.test(s.text()), "«Password:»")

    // A relay set by the holder, verified on the simulator itself.
    const on = await admin.client.action<ActionResult>(`/equipos/${ids.equipment}`, "setRelay", { equipmentId: ids.equipment, channelId: ids.channel, on: true, confirmed: false })
    expect(on).toMatchObject({ ok: true })
    expect(sim.state()[2]).toBe(true)
    const off = await admin.client.action<ActionResult>(`/equipos/${ids.equipment}`, "setRelay", { equipmentId: ids.equipment, channelId: ids.channel, on: false, confirmed: false })
    expect(off).toMatchObject({ ok: true })
    expect(sim.state()[2]).toBe(false)

    // Release → back to read-only.
    const rel = await admin.client.action<ActionResult>(`/equipos/${ids.equipment}`, "releaseReservation", { equipmentId: ids.equipment })
    expect(rel).toMatchObject({ ok: true })
    await s.waitMsg((m) => m.t === "mode" && m.mode === "ro", "modo ro")
    await s.close()
    await unknown.close()
    await anon.close()

    // Capture written to disk with timestamps, even with nobody watching.
    const files = await (await admin.client.get(`/api/consoles/${ids.console}/logs`)).json() as Array<{ name: string }>
    expect(files.length).toBeGreaterThan(0)
    const body = await (await admin.client.get(`/api/consoles/${ids.console}/logs/${encodeURIComponent(files[0].name)}`)).text()
    expect(body).toMatch(/^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] .*Password:/m)
  }, 60_000)

  it("shuts down cleanly (exit 0 on SIGTERM, lock released, server.pid removed)", async () => {
    expect(fs.existsSync(path.join(dataDir, "server.pid"))).toBe(true)
    const t0 = Date.now()
    server.kill("SIGTERM")
    const exit = await serverExit
    expect(exit.code).toBe(0)
    expect(Date.now() - t0).toBeLessThan(8000)
    expect(fs.existsSync(path.join(dataDir, "server.pid"))).toBe(false)
    // The instance lock is free again: `migrate` (which refuses with exit 5 while a server runs) succeeds.
    const migrate = cli(["migrate"])
    expect(migrate.stdout).toContain("al día")
    expect(migrate.status).toBe(0)
    expect(log).not.toMatch(/\[auth\]\[error\]|Error inesperado|uncaught/i)
  }, 20_000)
})
