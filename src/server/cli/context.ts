// Shared plumbing for CLI commands: config, exit codes, DB guard and audit.
import fs from "node:fs"
import path from "node:path"
import type { PrismaClient } from "@/generated/prisma/client"
import type { AppConfig } from "@/server/config/schema"
import type { LoadConfigOptions } from "@/server/config/load"
import { createPrismaClient } from "@/server/db/client"
import { ensureDbInvariants } from "@/server/db/invariants"
import { MigrationError, migrateDatabase } from "@/server/db/migrate"
import { seedDefaults } from "@/server/db/seed"
import { reloadProfileTemplates } from "@/server/profile"
import type { ActorRef, AuditInput } from "@/server/runtime/types"
import { writeAuditRow } from "@/server/ops/audit-raw"
import type { CliIO } from "./io"

export const CLI_ACTOR: ActorRef = Object.freeze({ kind: "cli", id: null, name: "cli" })

/** A controlled exit with a Spanish message (stderr) and an exit code (§2.11). */
export class CliExit extends Error {
  readonly exitCode: number
  constructor(exitCode: number, message: string) {
    super(message)
    this.name = "CliExit"
    this.exitCode = exitCode
  }
}

export interface CliDeps {
  io: CliIO
  env: Record<string, string | undefined>
  argv1: string | undefined
  cwd: string
  loadConfig: (opts: LoadConfigOptions) => AppConfig
  /** bcrypt cost (12; tests lower it). */
  bcryptRounds: number
}

export interface CliContext extends CliDeps { config: AppConfig }

/** Writes a CLI audit row; a failure is a warning, never a failed command. */
export function cliAudit(ctx: CliContext, input: Omit<AuditInput, "actor"> & { actor?: ActorRef }): void {
  try {
    writeAuditRow(ctx.config.dbFile, { ...input, actor: input.actor ?? CLI_ACTOR })
  } catch (err) {
    ctx.io.err(`Aviso: no se pudo registrar en la auditoría: ${err instanceof Error ? err.message : String(err)}\n`)
  }
}

/**
 * Opens the DB with Prisma for commands that need the current schema (user, config).
 * Refuses a missing DB (nothing is created) and a DB with pending or unknown migrations.
 * `ensureDefaults` applies what every server start applies (audit triggers, settings row, the profile's templates),
 * so a DB created by `migrate` alone behaves like one a server has opened.
 */
export async function openDatabase(ctx: CliContext, opts: { ensureDefaults?: boolean } = {}): Promise<PrismaClient> {
  const cfg = ctx.config
  if (!fs.existsSync(cfg.dbFile)) {
    throw new CliExit(1, `La base de datos no existe todavía (${cfg.dbFile}): inicia el servidor una vez o ejecuta relay-manager migrate`)
  }
  try {
    const r = await migrateDatabase({
      dbFile: cfg.dbFile, migrationsDir: path.join(cfg.appDir, "prisma", "migrations"), backupDir: null,
      dryRun: true, appVersion: cfg.build.version, log: () => {},
    })
    if (r.pending.length) {
      throw new CliExit(1, `La base de datos tiene migraciones pendientes (${r.pending.join(", ")}): inicia el servidor o ejecuta relay-manager migrate`)
    }
    if (r.unknown.length && !cfg.allowUnknownMigrations) {
      throw new CliExit(1, `La base de datos es de una versión más nueva (migraciones desconocidas: ${r.unknown.join(", ")})`)
    }
  } catch (err) {
    if (err instanceof MigrationError) throw new CliExit(1, err.message)
    throw err
  }
  const prisma = createPrismaClient(cfg.dbFile)
  if (opts.ensureDefaults) {
    try {
      await ensureDbInvariants(prisma)
      await seedDefaults(prisma, { labName: cfg.defaults.labName })
      await reloadProfileTemplates(prisma, cfg)
    } catch (err) {
      await prisma.$disconnect()
      throw err
    }
  }
  return prisma
}
