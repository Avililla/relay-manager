// `relay-manager doctor [--json]` (§4.14): read-only diagnosis; exit 1 only when a check fails.
import os from "node:os"
import { createBackupStore } from "@/server/ops/backup"
import { doctorExitCode, formatDoctorReport } from "@/server/ops/doctor"
import { nodeHealthContext, runHealthChecks, type HealthCtx } from "@/server/ops/health"
import { flagBool, parseArgs, UsageError } from "./args"
import type { CliContext } from "./context"

const MODE_LABEL = { native: "servicio", portable: "portátil", docker: "Docker", dev: "desarrollo" } as const

export async function doctorCommand(args: readonly string[], ctx: CliContext, overrides: Partial<HealthCtx> = {}): Promise<number> {
  const p = parseArgs(args, { boolean: ["json", "problems"], string: [] })
  if (p.positionals.length) throw new UsageError("Uso: relay-manager doctor [--json]")
  const cfg = ctx.config
  // Listing backups is read-only; the store never creates the directory unless a backup is made.
  const store = createBackupStore({ dbFile: cfg.dbFile, backupDir: cfg.backupDir, appVersion: cfg.build.version, audit: () => {} })
  const hctx: HealthCtx = { ...nodeHealthContext({ config: cfg, doctor: true, backups: () => store.list() }), ...overrides }
  const checks = await runHealthChecks(hctx)
  if (flagBool(p, "json")) {
    ctx.io.out(JSON.stringify(checks, null, 2) + "\n")
  } else {
    const header = `Diagnóstico de Relay Manager ${cfg.build.version} en ${os.hostname()} (modo ${MODE_LABEL[cfg.mode]}, datos en ${cfg.dataDir})`
    ctx.io.out(formatDoctorReport(checks, { color: ctx.io.stdoutIsTTY, header, onlyProblems: flagBool(p, "problems") }))
  }
  return doctorExitCode(checks)
}
