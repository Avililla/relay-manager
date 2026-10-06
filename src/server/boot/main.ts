// CLI dispatch (§9.2): start (default) and migrate here; every other command goes to runCli (W1-D).
import { createLogger, isUnderJournald } from "@/server/log"
import { runCli } from "@/server/cli"
import { acquireInstanceLock, isInstanceRunning } from "./instance-lock"
import { BootExit, loadConfigOrExit, runMigrations, start } from "./start"

async function migrateCommand(args: string[]): Promise<number> {
  const dryRun = args.includes("--dry-run")
  // A dry run is read-only: it creates no directory, secret or DB file.
  if (!dryRun) process.umask(0o027)
  const cfg = loadConfigOrExit(dryRun ? { ensureDirs: false, ensureSecret: false } : { ensureDirs: true, ensureSecret: true })
  const log = createLogger({ level: cfg.logLevel, journald: isUnderJournald() })
  if (dryRun) {
    const r = await runMigrations(cfg, log, true)
    process.stdout.write(r.pending.length ? `Migraciones pendientes: ${r.pending.join(", ")}\n` : "La base de datos está al día\n")
    if (r.unknown.length) process.stdout.write(`Migraciones desconocidas para esta versión: ${r.unknown.join(", ")}\n`)
    return 0
  }
  if (isInstanceRunning(cfg.dataDir)) throw new BootExit(5, `Otra instancia usa ${cfg.dataDir}: detén el servicio antes de migrar`)
  const lock = acquireInstanceLock(cfg.dataDir)
  try {
    const r = await runMigrations(cfg, log)
    process.stdout.write(r.applied.length ? `Migraciones aplicadas: ${r.applied.join(", ")}\n` : "La base de datos está al día\n")
    return 0
  } finally {
    lock.release()
  }
}

function fatal(err: unknown): number {
  if (err instanceof BootExit) {
    process.stderr.write(`relay-manager: ${err.message}\n`)
    return err.exitCode
  }
  process.stderr.write(`relay-manager: error inesperado: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`)
  return 1
}

export async function main(argv: string[]): Promise<void> {
  const [cmd = "start", ...args] = argv
  try {
    if (cmd === "start") {
      await start()
      return // the server keeps running
    }
    const code = cmd === "migrate" ? await migrateCommand(args) : await runCli(cmd, args)
    process.exit(code)
  } catch (err) {
    process.exit(fatal(err))
  }
}
