// CLI dispatch for every command except start/migrate (§9.2). Output is Spanish; usage errors exit 2.
import { loadConfig } from "@/server/config/load"
import type { LoadConfigOptions } from "@/server/config/load"
import { isDomainError } from "@/server/errors"
import { UsageError } from "./args"
import { backupCommand, restoreCommand } from "./backup"
import { CliExit, type CliContext, type CliDeps } from "./context"
import { doctorCommand } from "./doctor"
import { processIO } from "./io"
import { pingCommand } from "./ping"
import { setupTokenCommand } from "./setup-token"
import { userCommand } from "./user"
import { versionLine } from "./version"

export const USAGE = `Uso: relay-manager <orden> [opciones]

Órdenes:
  start                              inicia el servidor (por defecto)
  migrate [--dry-run]                aplica las migraciones pendientes (copia previa)
  doctor [--json]                    diagnóstico del sistema (solo lectura)
  setup-token                        muestra el código de configuración inicial
  user list|create|reset-password|enable|disable|set-admin …
  backup [--label <etiqueta>]        copia de seguridad de la base de datos
  restore <nombre|ruta> [--yes]      restaura una copia (con el servicio detenido)
  config export [<fichero>]          exporta la configuración (JSON)
  config import <fichero> [--dry-run]
  plantillas recargar                copia las plantillas del perfil (plantillas/*.json) a la base de datos
  plantillas comprobar               valida las plantillas del perfil sin cambiar nada
  ping                               comprueba que el servidor responde
  version                            muestra la versión
`

type Command = (args: readonly string[], ctx: CliContext) => Promise<number>
interface CommandDef { run: Command; config: LoadConfigOptions; writes: boolean }

const READ_ONLY: LoadConfigOptions = { ensureDirs: false, ensureSecret: false }
const DATA: LoadConfigOptions = { ensureDirs: true, ensureSecret: false }

const COMMANDS: Record<string, CommandDef> = {
  doctor: { run: doctorCommand, config: READ_ONLY, writes: false },
  "setup-token": { run: setupTokenCommand, config: READ_ONLY, writes: false },
  ping: { run: pingCommand, config: READ_ONLY, writes: false },
  user: { run: userCommand, config: DATA, writes: true },
  backup: { run: backupCommand, config: DATA, writes: true },
  restore: { run: restoreCommand, config: DATA, writes: true },
  // Loaded lazily: it pulls in the domain services (W1-C).
  config: { run: async (args, ctx) => (await import("./config")).configCommand(args, ctx), config: DATA, writes: true },
  // Never creates the data dir: `comprobar` only reads the profile, `recargar` needs an existing database.
  plantillas: { run: async (args, ctx) => (await import("./templates")).templatesCommand(args, ctx), config: READ_ONLY, writes: true },
}

function defaultDeps(): CliDeps {
  return {
    io: processIO(),
    env: process.env,
    argv1: process.argv[1],
    cwd: process.cwd(),
    loadConfig,
    bcryptRounds: 12,
  }
}

export async function runCli(cmd: string, args: string[], overrides: Partial<CliDeps> = {}): Promise<number> {
  const deps: CliDeps = { ...defaultDeps(), ...overrides }
  const io = deps.io
  try {
    if (cmd === "version" || cmd === "--version" || cmd === "-v") {
      io.out(versionLine({ env: deps.env, argv1: deps.argv1, cwd: deps.cwd, nodeVersion: process.versions.node }) + "\n")
      return 0
    }
    if (cmd === "help" || cmd === "--help" || cmd === "-h") {
      io.out(USAGE)
      return 0
    }
    const def = COMMANDS[cmd]
    if (!def) throw new UsageError(`Orden desconocida: ${cmd}\n\n${USAGE}`)
    // Same file modes as the server (§2.1): the DB and backups are never world-readable.
    if (def.writes) process.umask(0o027)
    const config = deps.loadConfig(def.config)
    return await def.run(args, { ...deps, config })
  } catch (err) {
    const prefix = `relay-manager ${cmd}: `
    if (err instanceof UsageError) {
      io.err(`${prefix}${err.message}\n`)
      return 2
    }
    if (err instanceof CliExit) {
      io.err(`${prefix}${err.message}\n`)
      return err.exitCode
    }
    if (err instanceof Error && err.name === "ConfigError") {
      io.err(`${prefix}${err.message}\n`)
      return 2
    }
    if (isDomainError(err)) {
      io.err(`${prefix}${err.message}\n`)
      return err.code === "VALIDATION" ? 2 : 1
    }
    io.err(`${prefix}error inesperado: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`)
    return 1
  }
}
