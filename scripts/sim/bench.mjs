#!/usr/bin/env node
// Full fake bench (§10.3): `pnpm sim` = node scripts/sim/bench.mjs [--only consoles|relays] [--config file]
// Spawns one fake Zynq console (scripts/sim/fake-zynq.py, W1-A) per console entry and one Devantech simulator
// (scripts/sim/devantech-sim.mjs) per relay entry, prefixes their output, prints the env block for the server,
// and stops everything (removing the pty links) on SIGINT/SIGTERM.
import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import readline from "node:readline"
import net from "node:net"
import { fileURLToPath, pathToFileURL } from "node:url"
import { FAKE_HW_SERVER, plugCable } from "./fake-jtag-cable.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const REPO = path.resolve(HERE, "..", "..")

export function loadBenchConfig(file = path.join(HERE, "bench.json")) {
  const cfg = JSON.parse(fs.readFileSync(file, "utf8"))
  if (!Array.isArray(cfg.consoles) || !Array.isArray(cfg.relays)) throw new Error(`Configuración del banco no válida: ${file}`)
  return cfg
}

/** `${XDG_RUNTIME_DIR}/relay-manager-sim`, or `<repo>/.data/sim` when a referenced variable is unset. */
export function resolveSimDir(cfg, env = process.env) {
  let missing = false
  const dir = String(cfg.simDir ?? "").replace(/\$\{(\w+)\}/g, (_, v) => {
    if (!env[v]) missing = true
    return env[v] ?? ""
  })
  return !dir || missing ? path.join(REPO, ".data", "sim") : path.resolve(dir)
}

/** The env block the server needs to see the fake bench. */
export function benchEnv(cfg, simDir, only = null) {
  const env = {}
  if (only !== "relays" && cfg.consoles.length) env.RM_SERIAL_EXTRA_GLOBS = `${simDir}/ttyV*`
  if (only !== "consoles" && cfg.relays.length) {
    const targets = [...new Set(cfg.relays.filter((r) => r.udp).map((r) => r.replyTo ?? "127.255.255.255"))]
    if (targets.length) env.RM_RELAY_DISCOVERY_BROADCASTS = targets.join(",")
    env.RM_RELAY_SCAN_CIDRS = "127.0.0.0/29"
    env.RM_RELAY_SCAN_PORTS = [...new Set(cfg.relays.map((r) => r.http).filter(Boolean))].slice(0, 4).join(",")
    env.RM_RELAY_SIMULATE = "1"
  }
  if (only === null && (cfg.jtag ?? []).length) {
    env.RM_JTAG_SYS_ROOT = path.join(simDir, "sys")
    env.RM_HW_SERVER = FAKE_HW_SERVER
  }
  return env
}

export function simulatorArgs(r) {
  const a = ["--model", r.model, "--host", r.host, "--http", String(r.http ?? 18080)]
  if (r.ascii) a.push("--ascii", String(r.ascii))
  if (r.eth) a.push("--eth", String(r.eth))
  if (r.udp) a.push("--udp")
  if (r.udpPort) a.push("--udp-port", String(r.udpPort))
  if (r.replyTo) a.push("--reply-to", r.replyTo)
  if (r.mac) a.push("--mac", r.mac)
  if (r.hostname) a.push("--hostname", r.hostname)
  if (r.var) a.push("--var", r.var)
  if (r.user) a.push("--user", r.user)
  if (r.pass) a.push("--pass", r.pass)
  if (r.tcpPass) a.push("--tcp-pass", r.tcpPass)
  if (r.pulse) a.push("--pulse", String(r.pulse))
  if (r.latency) a.push("--latency", String(r.latency))
  if (r.failRate) a.push("--fail-rate", String(r.failRate))
  return a
}

function prefixed(stream, prefix, out) {
  // The Devantech simulator already prefixes its own lines with the same "[model host]" tag.
  readline.createInterface({ input: stream }).on("line", (l) => out.write(l.startsWith(prefix) ? `${l}\n` : `${prefix} ${l}\n`))
}

/** Starts the bench. Returns { simDir, env, children, links, relays, stop() } (only what actually started). */
export async function startBench({ configFile, only = null, log = (l) => process.stdout.write(`${l}\n`), stdout = process.stdout, stderr = process.stderr } = {}) {
  const cfg = loadBenchConfig(configFile)
  const simDir = resolveSimDir(cfg)
  const children = []
  const links = []
  const relays = []

  if (only !== "relays" && cfg.consoles.length) {
    const zynq = path.join(HERE, "fake-zynq.py")
    const py = spawnSync("python3", ["--version"], { stdio: "ignore" })
    if (py.status !== 0) log("[banco] Aviso: python3 no está instalado: se omiten las consolas simuladas")
    else if (!fs.existsSync(zynq)) log("[banco] Aviso: falta scripts/sim/fake-zynq.py: se omiten las consolas simuladas")
    else {
      fs.mkdirSync(simDir, { recursive: true, mode: 0o750 })
      for (const c of cfg.consoles) {
        const link = path.join(simDir, c.link)
        links.push(link)
        const args = [zynq, "--link", link, "--stage", c.stage ?? "boot", "--host", c.host ?? c.link]
        if (c.autoboot !== undefined) args.push("--autoboot", String(c.autoboot))
        if (c.speed !== undefined) args.push("--speed", String(c.speed))
        const ch = spawn("python3", args, { stdio: ["ignore", "pipe", "pipe"] })
        const prefix = `[zynq ${c.link}]`
        prefixed(ch.stdout, prefix, stdout)
        prefixed(ch.stderr, prefix, stderr)
        children.push({ name: prefix, ch })
      }
    }
  }

  if (only !== "consoles") {
    for (const r of cfg.relays) {
      const ch = spawn(process.execPath, [path.join(HERE, "devantech-sim.mjs"), ...simulatorArgs(r)], { stdio: ["ignore", "pipe", "pipe"] })
      relays.push(r)
      const prefix = `[${r.model} ${r.host}]`
      prefixed(ch.stdout, prefix, stdout)
      prefixed(ch.stderr, prefix, stderr)
      children.push({ name: prefix, ch })
    }
  }

  // Fake JTAG cables (sysfs under <simDir>/sys) and fake Ethernet targets (a banner, then echo) for the accesses.
  const jtag = only === null ? cfg.jtag ?? [] : []
  const jtagRoot = path.join(simDir, "sys")
  for (const c of jtag) {
    plugCable(jtagRoot, { serial: c.serial, port: c.port ?? "9", xilinx: !!c.xilinx })
    log(`[banco] Cable JTAG simulado ${c.serial} (RM_JTAG_SYS_ROOT=${jtagRoot})`)
  }
  const targets = []
  for (const t of only === null ? cfg.tcpTargets ?? [] : []) {
    const srv = net.createServer((c) => {
      c.on("error", () => {})
      c.write(`${t.banner ?? "SSH-2.0-OpenSSH_9.6 (simulado)"}\r\n`)
      c.on("data", (d) => c.write(d))
    })
    srv.on("error", (e) => log(`[banco] Aviso: no se puede abrir el destino Ethernet simulado ${t.host}:${t.port}: ${e.message}`))
    srv.listen(t.port, t.host, () => log(`[banco] Destino Ethernet simulado en ${t.host}:${t.port}`))
    targets.push(srv)
  }

  let stopping = false
  for (const { name, ch } of children) {
    ch.on("exit", (code, signal) => { if (!stopping) log(`[banco] ${name} ha terminado (${signal ?? `código ${code}`})`) })
  }

  async function stop() {
    if (stopping) return
    stopping = true
    await Promise.all(children.map(({ ch }) => new Promise((resolve) => {
      if (ch.exitCode !== null || ch.signalCode !== null) return resolve()
      const t = setTimeout(() => ch.kill("SIGKILL"), 3000)
      ch.once("exit", () => { clearTimeout(t); resolve() })
      ch.kill("SIGTERM")
    })))
    for (const l of links) {
      try { if (fs.lstatSync(l).isSymbolicLink()) fs.unlinkSync(l) } catch { /* already gone */ }
    }
    for (const srv of targets) srv.close()
    if (jtag.length) fs.rmSync(jtagRoot, { recursive: true, force: true })
  }

  const started = { ...cfg, consoles: links.length ? cfg.consoles : [], relays }
  return { simDir, jtagRoot, env: benchEnv(started, simDir, only), children, links, relays, stop }
}

function parseArgs(argv) {
  const out = { only: null, config: undefined }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--only") out.only = argv[++i] ?? null
    else if (argv[i] === "--config") out.config = argv[++i]
  }
  if (out.only && !["consoles", "relays"].includes(out.only)) throw new Error("--only admite «consoles» o «relays»")
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const bench = await startBench({ configFile: args.config ? path.resolve(args.config) : undefined, only: args.only })
  const lines = Object.entries(bench.env).map(([k, v]) => `${k}=${v}`)
  process.stdout.write(`\nBanco simulado en marcha (${bench.children.length} procesos, carpeta ${bench.simDir}).\n`)
  process.stdout.write(`Variables para el servidor:\n\n${lines.join("\n")}\n\nPulsa Ctrl+C para detenerlo.\n\n`)
  const stop = () => { bench.stop().then(() => process.exit(0)) }
  process.on("SIGINT", stop)
  process.on("SIGTERM", stop)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { process.stderr.write(`Error del banco simulado: ${e.message}\n`); process.exit(1) })
}
