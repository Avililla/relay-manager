#!/usr/bin/env node
// Entorno de las capturas dentro de un contenedor Docker con red propia, para que la red de equipos salga «Lista».
//
//   node scripts/manuales/contenedor.mjs --dir <carpeta> [--port 3200] [--data-link …] [--tools-link …] [--files-link …]
//                                        [--perfil <carpeta>] [--manuales <carpeta>]
//
// Es el mismo entorno.mjs, pero en un contenedor (imagen relay-manager-manuales:local: ubuntu:24.04 + iproute2 +
// python3, se construye sola) con su propio espacio de red: red-equipos.sh monta dentro la tarjeta del laboratorio,
// el adaptador USB, el switch con VLAN y cuatro equipos con la misma IP, y arranca entorno.mjs con tu usuario y solo
// CAP_NET_ADMIN. El contenedor es --privileged (hace falta para los espacios de red), pero NUNCA usa la red del
// anfitrión: las VLAN, rutas y reglas que crea la aplicación se quedan dentro. Fuera solo se publican, en 127.0.0.1,
// el control (<port>+89) y el proxy de los navegadores (<port>+98); los Chrome y capturas.mjs siguen en el anfitrión.
// El repositorio, node y /tmp se montan en las mismas rutas (la carpeta y los enlaces deben estar bajo /tmp o dentro
// del repositorio; el perfil y la carpeta de los manuales, en solo lectura). Se detiene con GET /stop del control, Ctrl+C o `docker rm -f rm-manuales-<port>`; el registro del contenedor queda
// en <carpeta>/contenedor.log.
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, "..", "..")
export const IMAGE = "relay-manager-manuales:local"
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function docker(args, opts = {}) {
  const r = spawnSync("docker", args, { encoding: "utf8", ...opts })
  if (r.error) throw r.error
  return r
}

function ensureImage() {
  if (docker(["image", "inspect", IMAGE]).status === 0) return
  process.stdout.write(`[manuales] Construyendo la imagen ${IMAGE} (ubuntu:24.04 + iproute2 + python3)\n`)
  const df = "FROM ubuntu:24.04\nRUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends iproute2 python3 tzdata && rm -rf /var/lib/apt/lists/*\n"
  const r = docker(["build", "-q", "-t", IMAGE, "-"], { input: df, stdio: ["pipe", "inherit", "inherit"] })
  if (r.status !== 0) throw new Error(`No se pudo construir ${IMAGE}`)
}

/**
 * Lo que Salud y Descubrimiento consultan del sistema anfitrión, en solo lectura, para que salga como fuera del
 * contenedor: systemctl (por el bus D-Bus del sistema: ModemManager y el servicio), brltty y la regla udev.
 */
function hostMirrors() {
  const ro = (p, to = p) => (fs.existsSync(p) ? ["-v", `${p}:${to}:ro`] : [])
  const sd = "/usr/lib/x86_64-linux-gnu/systemd"
  const out = []
  if (fs.existsSync("/usr/bin/systemctl") && fs.existsSync("/run/dbus/system_bus_socket") && fs.existsSync(sd)) {
    out.push(...ro("/usr/bin/systemctl"), ...ro(sd), "-v", "/run/dbus/system_bus_socket:/run/dbus/system_bus_socket", ...ro("/run/systemd/system"))
  }
  out.push(...ro("/usr/bin/brltty"), ...ro("/etc/udev/rules.d/99-relay-manager.rules"))
  return out
}

/** Arranca el contenedor y espera al entorno. Devuelve { name, stop }. */
export async function startContainerEnv({ dir, port = 3200, dataLink = null, toolsLink = null, filesLink = null, perfil = null, manuales = null, log = (s) => process.stdout.write(`${s}\n`) }) {
  ensureImage()
  const root = path.resolve(dir)
  fs.mkdirSync(root, { recursive: true })
  const under = (p, base) => p === base || p.startsWith(`${base}/`)
  for (const p of [root, dataLink, toolsLink, filesLink].filter(Boolean)) {
    if (!under(path.resolve(p), "/tmp") && !under(path.resolve(p), REPO)) throw new Error(`${p}: con el contenedor, la carpeta y los enlaces deben estar bajo /tmp o dentro del repositorio`)
  }
  const nodeDir = path.dirname(path.dirname(process.execPath))
  const name = `rm-manuales-${port}`
  docker(["rm", "-f", name])
  fs.rmSync(path.join(root, "entorno.json"), { force: true })
  const ctl = port + 89
  const proxy = port + 98
  const args = [
    "run", "-d", "--name", name, "--privileged", "--hostname", os.hostname(), "--init",
    "-p", `127.0.0.1:${ctl}:${ctl}`, "-p", `127.0.0.1:${proxy}:${proxy}`,
    "-v", `${REPO}:${REPO}`, "-v", `${nodeDir}:${nodeDir}:ro`, "-v", "/tmp:/tmp",
    "-v", "/etc/passwd:/etc/passwd:ro", "-v", "/etc/group:/etc/group:ro",
    ...(fs.existsSync("/usr/lib/os-release") ? ["-v", "/usr/lib/os-release:/etc/os-release:ro"] : []),
    ...hostMirrors(),
    // El perfil y las fuentes de los manuales (fuera del repositorio), en solo lectura y en la misma ruta.
    ...[perfil, manuales].filter(Boolean).flatMap((p) => ["-v", `${path.resolve(p)}:${path.resolve(p)}:ro`]),
    "-e", `RM_NODE=${process.execPath}`, "-e", `RM_UID=${process.getuid()}`, "-e", `RM_GID=${process.getgid()}`,
    "-e", `RM_REPO=${REPO}`, "-e", `RM_CTR_DIR=${root}`, "-e", `TZ=${process.env.TZ ?? "Europe/Madrid"}`,
    "-e", `HOME=${os.homedir()}`, "-e", `PATH=${nodeDir}/bin:/usr/sbin:/usr/bin:/sbin:/bin`, "-e", "LANG=C.UTF-8",
    "-w", REPO, IMAGE, "bash", path.join(HERE, "red-equipos.sh"),
    "--dir", root, "--port", String(port), "--ctl", String(ctl), "--proxy", String(proxy), "--bind", "0.0.0.0", "--red-equipos", "contenedor",
    ...(dataLink ? ["--data-link", dataLink] : []), ...(toolsLink ? ["--tools-link", toolsLink] : []), ...(filesLink ? ["--files-link", filesLink] : []),
    ...(perfil ? ["--perfil", path.resolve(perfil)] : []), ...(manuales ? ["--manuales", path.resolve(manuales)] : []),
  ]
  const r = docker(args)
  if (r.status !== 0) throw new Error(`docker run: ${r.stderr}`)
  const logs = () => docker(["logs", name]).stdout + docker(["logs", name]).stderr
  const end = Date.now() + 120_000
  for (;;) {
    if (fs.existsSync(path.join(root, "entorno.json"))) {
      try { if ((await fetch(`http://127.0.0.1:${ctl}/state`)).ok) break } catch { /* aún no */ }
    }
    if (docker(["inspect", "-f", "{{.State.Running}}", name]).stdout.trim() !== "true") throw new Error(`El contenedor ${name} ha terminado:\n${logs()}`)
    if (Date.now() > end) throw new Error(`Tiempo agotado esperando al entorno del contenedor ${name}:\n${logs()}`)
    await sleep(500)
  }
  log(`[manuales] Entorno en el contenedor ${name}: control en http://127.0.0.1:${ctl}, proxy de los navegadores en 127.0.0.1:${proxy}`)
  async function stop() {
    try { await fetch(`http://127.0.0.1:${ctl}/stop`) } catch { /* ya parado */ }
    for (let i = 0; i < 40 && docker(["inspect", "-f", "{{.State.Running}}", name]).stdout.trim() === "true"; i++) await sleep(500)
    const out = docker(["logs", name])
    if (out.status === 0) fs.writeFileSync(path.join(root, "contenedor.log"), out.stdout + out.stderr)
    docker(["rm", "-f", name])
  }
  return { name, stop }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2)
  const val = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null }
  if (!val("--dir")) throw new Error("Uso: node scripts/manuales/contenedor.mjs --dir <carpeta> [--port 3200] [--data-link …] [--tools-link …] [--files-link …] [--perfil <carpeta>] [--manuales <carpeta>]")
  const abs = (p) => (p ? path.resolve(p) : null)
  const c = await startContainerEnv({ dir: val("--dir"), port: Number(val("--port") ?? 3200), dataLink: abs(val("--data-link")), toolsLink: abs(val("--tools-link")), filesLink: abs(val("--files-link")), perfil: abs(val("--perfil")), manuales: abs(val("--manuales")) })
  const bye = () => { void c.stop().then(() => process.exit(0)) }
  process.on("SIGINT", bye)
  process.on("SIGTERM", bye)
  // Sigue en marcha mientras lo haga el contenedor (GET /stop del control lo para).
  for (;;) {
    await sleep(2000)
    if (docker(["inspect", "-f", "{{.State.Running}}", c.name]).stdout.trim() !== "true") { await c.stop(); process.exit(0) }
  }
}
