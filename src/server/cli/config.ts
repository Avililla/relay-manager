// `relay-manager config export [<file>]` / `config import <file> [--dry-run]` (§9.2), through W1-C's config-io.
import fs from "node:fs"
import path from "node:path"
import { acquireInstanceLock, InstanceLockedError, isInstanceRunning } from "@/server/boot/instance-lock"
import { isDomainError } from "@/server/errors"
import { exportConfig, importConfig } from "@/server/services/config-io"
import { flagBool, parseArgs, UsageError } from "./args"
import { cliAudit, CliExit, openDatabase, type CliContext } from "./context"

const USAGE = "Uso: relay-manager config export [<fichero>] | relay-manager config import <fichero> [--dry-run]"
const LOCKED = "Detén el servicio antes de importar: sudo systemctl stop relay-manager"

export async function configCommand(args: readonly string[], ctx: CliContext): Promise<number> {
  const [sub, ...rest] = args
  if (sub === "export") {
    const p = parseArgs(rest, { boolean: [], string: [] })
    if (p.positionals.length > 1) throw new UsageError(USAGE)
    const prisma = await openDatabase(ctx)
    try {
      const cfg = await exportConfig(prisma, { appVersion: ctx.config.build.version })
      const json = JSON.stringify(cfg, null, 2) + "\n"
      const file = p.positionals[0]
      cliAudit(ctx, { action: "config.export", target: { type: "config", id: null, name: file ? path.basename(file) : "stdout" } })
      if (file && file !== "-") {
        fs.writeFileSync(file, json, { mode: 0o640 })
        ctx.io.err(`Configuración exportada en ${path.resolve(file)} (${cfg.equipment.length} equipos, ${cfg.templates.length} plantillas, ${cfg.boards.length} placas, ${cfg.roles.length} roles)\n`)
      } else {
        ctx.io.out(json)
      }
      return 0
    } finally {
      await prisma.$disconnect()
    }
  }

  if (sub === "import") {
    const p = parseArgs(rest, { boolean: ["dry-run"], string: [] })
    if (p.positionals.length !== 1) throw new UsageError(USAGE)
    const dryRun = flagBool(p, "dry-run")
    let json: string
    try {
      json = fs.readFileSync(p.positionals[0], "utf8")
    } catch (err) {
      throw new CliExit(1, `No se puede leer ${p.positionals[0]}: ${err instanceof Error ? err.message : String(err)}`)
    }
    // A real import refuses while a server holds the instance lock (D37); a dry run only reads.
    let lock: { release(): void } | null = null
    if (!dryRun) {
      if (isInstanceRunning(ctx.config.dataDir)) throw new CliExit(5, LOCKED)
      try {
        lock = acquireInstanceLock(ctx.config.dataDir)
      } catch (err) {
        if (err instanceof InstanceLockedError) throw new CliExit(5, LOCKED)
        throw err
      }
    }
    try {
      // A dry run changes nothing; a real import first applies the server's start-up defaults (the profile's templates).
      const prisma = await openDatabase(ctx, { ensureDefaults: !dryRun })
      try {
        const report = await importConfig(prisma, json, { dryRun, accessPorts: { range: ctx.config.accesses.range, httpPort: ctx.config.port } }, { kind: "cli", id: null, name: "cli" }).catch((err: unknown) => {
          if (isDomainError(err)) {
            const fields = err.fieldErrors ? Object.entries(err.fieldErrors).slice(0, 10).map(([k, v]) => `\n  ${k}: ${v.join(", ")}`).join("") : ""
            throw new CliExit(err.code === "VALIDATION" ? 2 : 1, `${err.message}${fields}`)
          }
          throw err
        })
        if (!dryRun) cliAudit(ctx, { action: "config.import", target: { type: "config", id: null, name: path.basename(p.positionals[0]) }, detail: { created: report.created, skipped: report.skipped.length } })
        const c = report.created
        ctx.io.out(`${dryRun ? "Simulación (no se ha cambiado nada)" : "Importación completada"}: ${c.equipment} equipos, ${c.templates} plantillas, ${c.boards} placas y ${c.roles} roles${dryRun ? " se crearían" : " creados"}.\n`)
        for (const s of report.skipped) ctx.io.out(`  Omitido (${s.kind}) «${s.name}»: ${s.reason}\n`)
        for (const w of report.warnings) ctx.io.out(`  Aviso: ${w}\n`)
        return 0
      } finally {
        await prisma.$disconnect()
      }
    } finally {
      lock?.release()
    }
  }

  throw new UsageError(USAGE)
}
