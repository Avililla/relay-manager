// `relay-manager backup [--label <l>]` and `relay-manager restore <name|path> [--yes]` (§9.2, §4.14).
import path from "node:path"
import { formatDateTime } from "@/lib/i18n/format"
import { createBackupStore } from "@/server/ops/backup"
import { restoreBackup } from "@/server/ops/restore"
import { flagBool, flagString, parseArgs, UsageError } from "./args"
import { cliAudit, CLI_ACTOR, CliExit, type CliContext } from "./context"

export async function backupCommand(args: readonly string[], ctx: CliContext): Promise<number> {
  const p = parseArgs(args, { boolean: [], string: ["label"] })
  if (p.positionals.length) throw new UsageError("Uso: relay-manager backup [--label <etiqueta>]")
  const cfg = ctx.config
  const store = createBackupStore({
    dbFile: cfg.dbFile, backupDir: cfg.backupDir, appVersion: cfg.build.version,
    audit: (input) => cliAudit(ctx, input),
  })
  const b = await store.create(flagString(p, "label") ?? "manual", CLI_ACTOR)
  ctx.io.out(`${path.join(cfg.backupDir, b.name)}\n`)
  return 0
}

export async function restoreCommand(args: readonly string[], ctx: CliContext): Promise<number> {
  const p = parseArgs(args, { boolean: ["yes"], string: [] })
  if (p.positionals.length !== 1) throw new UsageError("Uso: relay-manager restore <nombre|ruta> [--yes]")
  const yes = flagBool(p, "yes")
  if (!yes && !ctx.io.stdinIsTTY) throw new UsageError("Sin terminal: confirma la restauración con --yes")
  const cfg = ctx.config
  const res = await restoreBackup({
    dataDir: cfg.dataDir, dbFile: cfg.dbFile, backupDir: cfg.backupDir, appVersion: cfg.build.version,
    source: p.positionals[0], actor: CLI_ACTOR,
    log: (m) => ctx.io.out(`${m}\n`),
    confirm: yes ? undefined : async (info) => {
      const when = info.createdAt ? `, creada el ${formatDateTime(info.createdAt)}` : ""
      const answer = await ctx.io.prompt(
        `Se sustituirá la base de datos actual (${cfg.dbFile}) por ${info.name}${when}.\nSe perderán los cambios posteriores a esa copia. ¿Continuar? [s/N] `, false)
      return /^s[ií]?$/i.test(answer.trim())
    },
  }).catch((err: unknown) => {
    if (err instanceof Error && err.name === "RestoreError") {
      const code = (err as Error & { exitCode?: number }).exitCode ?? 1
      throw new CliExit(code, err.message)
    }
    throw err
  })
  ctx.io.out(`Base de datos restaurada desde ${res.restored}.\n`)
  if (res.preRestore) ctx.io.out(`La base de datos anterior se guardó en ${res.preRestore}.\n`)
  ctx.io.out("Al iniciar, el servidor aplicará las migraciones pendientes si la copia es de una versión anterior.\n")
  return 0
}
