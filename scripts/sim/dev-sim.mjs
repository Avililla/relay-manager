#!/usr/bin/env node
// `pnpm dev:sim` (§10.3): starts the fake bench, then the dev server (RM_DEV=1 tsx server.ts) with the bench env.
// The server banner prints the setup token; after `pnpm dev:seed` the seeded logins are listed here.
import { spawn } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import { REPO, startBench } from "./bench.mjs"

const canConnect = (host, port) => new Promise((resolve) => {
  const s = net.connect({ host, port })
  const done = (v) => { s.destroy(); resolve(v) }
  s.setTimeout(300, () => done(false))
  s.once("connect", () => done(true))
  s.once("error", () => done(false))
})

/** Waits for what the bench actually started: each simulator's HTTP port and each console's pty link. */
async function waitReady(bench, timeoutMs = 8000) {
  const until = Date.now() + timeoutMs
  let left = [
    ...bench.relays.map((r) => ({ kind: "tcp", host: r.host, port: r.http ?? 18080 })),
    ...bench.links.map((l) => ({ kind: "link", path: l })),
  ]
  while (left.length && Date.now() < until) {
    const next = []
    for (const p of left) {
      const ok = p.kind === "tcp" ? await canConnect(p.host, p.port) : fs.existsSync(p.path)
      if (!ok) next.push(p)
    }
    left = next
    if (left.length) await new Promise((r) => setTimeout(r, 200))
  }
  return left
}

async function main() {
  const bench = await startBench()
  const missing = await waitReady(bench)
  if (missing.length) process.stdout.write(`[banco] Aviso: ${missing.length} simulador(es) no responden todavía\n`)

  const env = { ...process.env, ...bench.env, RM_DEV: "1" }
  const dataDir = path.resolve(env.RM_DATA_DIR ?? path.join(REPO, ".data"))
  process.stdout.write(`\n[banco] Variables: ${Object.entries(bench.env).map(([k, v]) => `${k}=${v}`).join(" ")}\n`)
  if (fs.existsSync(path.join(dataDir, "seed.json"))) {
    const pw = env.RM_DEV_PASSWORD ?? "dev-password-1"
    process.stdout.write(`[banco] Datos de ejemplo cargados: usuarios «admin» (administrador) y «operador», contraseña «${pw}»\n`)
  } else {
    process.stdout.write("[banco] Sin datos de ejemplo: completa /setup con el código que muestra el servidor (o ejecuta pnpm dev:seed con el servidor parado)\n")
  }
  process.stdout.write("\n")

  const tsx = path.join(REPO, "node_modules", ".bin", "tsx")
  const server = spawn(tsx, ["server.ts"], { cwd: REPO, env, stdio: "inherit" })
  let stopping = false
  const stop = async (code = 0) => {
    if (stopping) return
    stopping = true
    if (server.exitCode === null && server.signalCode === null) {
      await new Promise((resolve) => {
        const t = setTimeout(() => server.kill("SIGKILL"), 10_000)
        server.once("exit", () => { clearTimeout(t); resolve() })
        server.kill("SIGTERM")
      })
    }
    await bench.stop()
    process.exit(code)
  }
  server.on("exit", (code) => { void stop(code ?? 0) })
  process.on("SIGINT", () => { void stop(0) })
  process.on("SIGTERM", () => { void stop(0) })
}

main().catch((e) => { process.stderr.write(`Error de dev:sim: ${e.message}\n`); process.exit(1) })
