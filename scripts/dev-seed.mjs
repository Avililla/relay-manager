// pnpm dev:seed (§10.3, dev only): fills the dev data dir with the shared fake bench and two logins.
//   1. renders scripts/sim/bench-config.template.json (${SIM_DIR} → the bench's pty dir) into <dataDir>/seed.json
//   2. relay-manager migrate, config import <seed.json>, user create admin --admin, user create operador
// Runs the CLI as `RM_DEV=1 tsx server.ts <cmd>` against RM_DATA_DIR (default <repo>/.data). Stop `pnpm dev`
// first: `config import` refuses (exit 5) while a server holds the instance lock.
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const dataDir = path.resolve(repo, process.env.RM_DATA_DIR || ".data")
const password = process.env.RM_DEV_PASSWORD || "dev-password-1"
const template = path.join(repo, "scripts", "sim", "bench-config.template.json")
const benchJson = path.join(repo, "scripts", "sim", "bench.json")

function fail(msg) {
  console.error(`dev:seed: ${msg}`)
  process.exit(1)
}

/** Same rule as bench.mjs: bench.json simDir with ${VAR} expanded; <repo>/.data/sim when XDG_RUNTIME_DIR is unset. */
function simDir() {
  if (process.env.SIM_DIR) return path.resolve(process.env.SIM_DIR)
  let raw = "${XDG_RUNTIME_DIR}/relay-manager-sim"
  try {
    const cfg = JSON.parse(fs.readFileSync(benchJson, "utf8"))
    if (typeof cfg.simDir === "string") raw = cfg.simDir
  } catch {
    /* bench.json not present: use the documented default */
  }
  const missing = [...raw.matchAll(/\$\{(\w+)\}/g)].some((m) => !process.env[m[1]])
  if (missing) return path.join(repo, ".data", "sim")
  return path.resolve(raw.replace(/\$\{(\w+)\}/g, (_m, v) => process.env[v] ?? ""))
}

function cli(args, input) {
  const r = spawnSync(process.execPath, ["--import", "tsx", "server.ts", ...args], {
    cwd: repo,
    env: { ...process.env, RM_DEV: "1", RM_DATA_DIR: dataDir, RM_LOG_LEVEL: process.env.RM_LOG_LEVEL || "warn" },
    input,
    encoding: "utf8",
  })
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() }
}

if (!fs.existsSync(template)) fail(`falta ${path.relative(repo, template)} (lo aporta W1-B)`)
const sim = simDir()
fs.mkdirSync(dataDir, { recursive: true, mode: 0o750 })
const rendered = fs.readFileSync(template, "utf8").replaceAll("${SIM_DIR}", sim)
try {
  JSON.parse(rendered)
} catch (err) {
  fail(`la plantilla no es JSON válido tras sustituir \${SIM_DIR}: ${err instanceof Error ? err.message : String(err)}`)
}
const seedFile = path.join(dataDir, "seed.json")
fs.writeFileSync(seedFile, rendered, { mode: 0o640 })
console.log(`Plantilla del banco simulado → ${path.relative(repo, seedFile)} (SIM_DIR=${sim})`)

const migrate = cli(["migrate"])
if (migrate.code === 5) fail("hay un servidor en marcha sobre este directorio de datos: detén pnpm dev y repite")
if (migrate.code !== 0) fail(`migrate terminó con ${migrate.code}:\n${migrate.out}`)
console.log(migrate.out)

const imp = cli(["config", "import", seedFile])
if (imp.code === 5) fail("hay un servidor en marcha sobre este directorio de datos: detén pnpm dev y repite")
if (imp.code !== 0) fail(`config import terminó con ${imp.code}:\n${imp.out}`)
console.log(imp.out)

for (const [username, extra] of [["admin", ["--admin"]], ["operador", []]]) {
  const r = cli(["user", "create", username, ...extra, "--password-stdin"], `${password}\n`)
  if (r.code === 0) console.log(r.out)
  else if (r.out.includes("Ya existe")) console.log(`El usuario «${username}» ya existía: no se cambia su contraseña`)
  else fail(`user create ${username} terminó con ${r.code}:\n${r.out}`)
}

console.log(`
Datos de desarrollo listos en ${path.relative(repo, dataDir) || "."}. Accesos:
  admin     / ${password}   (administrador)
  operador  / ${password}   (deberá cambiar la contraseña al entrar)
Arranca con: pnpm dev:sim   (o pnpm dev con las variables que imprime pnpm sim)`)
