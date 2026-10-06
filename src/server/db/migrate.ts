/**
 * In-app migration runner (§3.2). better-sqlite3 only: no Prisma CLI or schema engine ships.
 * Applies prisma/migrations/<name>/migration.sql in lexical order and records them in Prisma's own
 * `_prisma_migrations` table exactly like the schema engine does, so `prisma migrate status/deploy`
 * keep working on dev machines.
 */
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import Database from "better-sqlite3"

export interface MigrateOptions {
  dbFile: string
  migrationsDir: string            // <appDir>/prisma/migrations
  backupDir: string | null         // null in tests
  dryRun?: boolean
  allowUnknown?: boolean           // RM_ALLOW_UNKNOWN_MIGRATIONS
  log?: (level: "info" | "warn", msg: string) => void
  appVersion: string
}
export interface MigrateResult { applied: string[]; pending: string[]; unknown: string[]; backup: string | null; created: boolean }

export class MigrationError extends Error {
  readonly code: "FAILED" | "UNKNOWN_MIGRATIONS" | "RECORDED_FAILURE"
  readonly migration?: string
  constructor(code: MigrationError["code"], message: string, migration?: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "MigrationError"
    this.code = code
    this.migration = migration
  }
}

const DDL = `CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
    "id"                    TEXT PRIMARY KEY NOT NULL,
    "checksum"              TEXT NOT NULL,
    "finished_at"           DATETIME,
    "migration_name"        TEXT NOT NULL,
    "logs"                  TEXT,
    "rolled_back_at"        DATETIME,
    "started_at"            DATETIME NOT NULL DEFAULT current_timestamp,
    "applied_steps_count"   INTEGER UNSIGNED NOT NULL DEFAULT 0
)`

interface MigrationRow { name: string; checksum: string; finished_at: number | string | null; rolled_back_at: number | string | null }

const PRE_MIGRATE_KEEP = 5
/** Earlier checksums of migrations whose file was later edited without changing what an existing DB needs
 * (3.0.0: only the default lab name of the init migration became generic). Not a mismatch. */
const PREVIOUS_CHECKSUMS: Readonly<Record<string, readonly string[]>> = {
  "20260923000000_init": ["dd6c82e795571ea540dc38c9397329754eb28031b565986cb569c9143a3ee8f7"],
}
const PRE_UPGRADE_FRESH_MS = 60 * 60_000

function sha256(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex")
}

/** "20260923T101500Z" (UTC, second precision) */
export function backupTimestamp(d: Date = new Date()): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")
}
function parseBackupTimestamp(ts: string): number {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(ts)
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : Number.NaN
}
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

export function listMigrations(migrationsDir: string): string[] {
  if (!fs.existsSync(migrationsDir)) return []
  return fs.readdirSync(migrationsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(migrationsDir, d.name, "migration.sql")))
    .map((d) => d.name)
    .sort()
}

function readRows(db: Database.Database): MigrationRow[] {
  return db.prepare(`SELECT migration_name AS name, checksum, finished_at, rolled_back_at FROM _prisma_migrations`).all() as MigrationRow[]
}

function analyse(rows: MigrationRow[], names: string[], migrationsDir: string, log: NonNullable<MigrateOptions["log"]>) {
  const failed = rows.filter((r) => r.finished_at === null && r.rolled_back_at === null)
  const done = new Map(rows.filter((r) => r.rolled_back_at === null && r.finished_at !== null).map((r) => [r.name, r.checksum]))
  const known = new Set(names)
  const unknown = [...done.keys()].filter((n) => !known.has(n)).sort()
  for (const [name, sum] of done) {
    if (!known.has(name)) continue
    const current = sha256(fs.readFileSync(path.join(migrationsDir, name, "migration.sql")))
    if (current !== sum && !PREVIOUS_CHECKSUMS[name]?.includes(sum)) log("warn", `La migración ${name} aplicada no coincide con la de esta versión (checksum distinto)`)
  }
  const pending = names.filter((n) => !done.has(n))
  return { failed, done, unknown, pending }
}

function unknownError(unknown: string[]): MigrationError {
  return new MigrationError(
    "UNKNOWN_MIGRATIONS",
    `La base de datos tiene migraciones que esta versión no conoce (${unknown.join(", ")}). ` +
      "Probablemente se instaló una versión más nueva. Restaura la copia previa a la actualización con: relay-manager restore <copia pre-upgrade>",
  )
}

function recordedFailureError(names: string[]): MigrationError {
  return new MigrationError(
    "RECORDED_FAILURE",
    `Hay migraciones registradas como fallidas: ${names.join(", ")}. Restaura una copia de seguridad antes de continuar.`,
    names[0],
  )
}

function hasFreshPreUpgradeBackup(backupDir: string, appVersion: string, now: number): boolean {
  let files: string[]
  try { files = fs.readdirSync(backupDir) } catch { return false }
  const re = new RegExp(`^relay-manager-(\\d{8}T\\d{6}Z)-pre-upgrade-[0-9A-Za-z.+-]+-to-${escapeRe(appVersion)}\\.db$`)
  return files.some((f) => {
    const m = re.exec(f)
    if (!m) return false
    const t = parseBackupTimestamp(m[1])
    return Number.isFinite(t) && now - t <= PRE_UPGRADE_FRESH_MS && t - now <= PRE_UPGRADE_FRESH_MS
  })
}

async function takeBackup(db: Database.Database, backupDir: string, appVersion: string, applied: string[]): Promise<string> {
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o750 })
  const ts = backupTimestamp()
  let label = "pre-migrate"
  let file = path.join(backupDir, `relay-manager-${ts}-${label}.db`)
  for (let i = 2; fs.existsSync(file); i++) {
    label = `pre-migrate-${i}`
    file = path.join(backupDir, `relay-manager-${ts}-${label}.db`)
  }
  await db.backup(file)
  fs.chmodSync(file, 0o640)
  const sidecar = {
    createdAt: new Date().toISOString(), label: "pre-migrate", appVersion, migrations: applied, sizeBytes: fs.statSync(file).size,
  }
  fs.writeFileSync(file.replace(/\.db$/, ".json"), JSON.stringify(sidecar, null, 2) + "\n", { mode: 0o640 })
  return file
}

function prunePreMigrate(backupDir: string, log: NonNullable<MigrateOptions["log"]>): void {
  const re = /^relay-manager-\d{8}T\d{6}Z-pre-migrate(-\d+)?\.db$/
  const files = fs.readdirSync(backupDir).filter((f) => re.test(f)).sort().reverse()
  for (const f of files.slice(PRE_MIGRATE_KEEP)) {
    try {
      fs.rmSync(path.join(backupDir, f), { force: true })
      fs.rmSync(path.join(backupDir, f.replace(/\.db$/, ".json")), { force: true })
    } catch (err) {
      log("warn", `No se pudo borrar la copia antigua ${f}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

function dryRun(opts: MigrateOptions, names: string[], log: NonNullable<MigrateOptions["log"]>): MigrateResult {
  if (!fs.existsSync(opts.dbFile)) {
    log("info", "Sin base de datos: se creará al iniciar")
    return { applied: [], pending: names, unknown: [], backup: null, created: false }
  }
  const db = new Database(opts.dbFile, { readonly: true, fileMustExist: true })
  try {
    const hasTable = db.prepare(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = '_prisma_migrations'`).get()
    const rows = hasTable ? readRows(db) : []
    const { failed, unknown, pending } = analyse(rows, names, opts.migrationsDir, log)
    if (failed.length) throw recordedFailureError(failed.map((f) => f.name))
    if (unknown.length) log("warn", `Migraciones desconocidas para esta versión: ${unknown.join(", ")}`)
    log("info", pending.length ? `Migraciones pendientes: ${pending.join(", ")}` : "La base de datos está al día")
    return { applied: [], pending, unknown, backup: null, created: false }
  } finally {
    db.close()
  }
}

export async function migrateDatabase(opts: MigrateOptions): Promise<MigrateResult> {
  const log = opts.log ?? (() => {})
  const names = listMigrations(opts.migrationsDir)
  if (opts.dryRun) return dryRun(opts, names, log)

  const existed = fs.existsSync(opts.dbFile)
  fs.mkdirSync(path.dirname(opts.dbFile), { recursive: true, mode: 0o750 })
  const db = new Database(opts.dbFile)
  try {
    db.pragma("busy_timeout = 10000")
    db.pragma("journal_mode = WAL")
    db.exec(DDL)

    const { failed, done, unknown, pending } = analyse(readRows(db), names, opts.migrationsDir, log)
    if (failed.length) throw recordedFailureError(failed.map((f) => f.name))
    if (unknown.length) {
      if (!opts.allowUnknown) throw unknownError(unknown)
      log("warn", `Se continúa con migraciones desconocidas (RM_ALLOW_UNKNOWN_MIGRATIONS=1): ${unknown.join(", ")}`)
    }
    if (!pending.length) {
      log("info", "La base de datos está al día")
      return { applied: [], pending: [], unknown, backup: null, created: !existed }
    }

    let backup: string | null = null
    if (existed && opts.backupDir) {
      if (hasFreshPreUpgradeBackup(opts.backupDir, opts.appVersion, Date.now())) {
        log("info", "Copia previa a la migración omitida: hay una copia pre-upgrade reciente")
      } else {
        try {
          backup = await takeBackup(db, opts.backupDir, opts.appVersion, [...done.keys()].sort())
          log("info", `Copia de seguridad previa a la migración: ${backup}`)
        } catch (err) {
          throw new MigrationError(
            "FAILED",
            `No se pudo hacer la copia de seguridad previa a la migración en ${opts.backupDir}: ${err instanceof Error ? err.message : String(err)}. No se ha aplicado ninguna migración.`,
            undefined,
            { cause: err },
          )
        }
      }
    }

    const insert = db.prepare(
      `INSERT INTO _prisma_migrations (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
       VALUES (?, ?, ?, ?, NULL, NULL, ?, 1)`,
    )
    const applied: string[] = []
    for (const name of pending) {
      const sql = fs.readFileSync(path.join(opts.migrationsDir, name, "migration.sql"))
      const started = Date.now()
      // PRAGMA foreign_keys is a no-op inside a transaction: switch it off BEFORE BEGIN, otherwise
      // Prisma's "RedefineTables" DROP TABLE fires ON DELETE CASCADE and silently deletes child rows.
      db.pragma("foreign_keys = OFF")
      try {
        db.transaction(() => {
          db.exec(sql.toString("utf8"))
          const violations = db.pragma("foreign_key_check") as unknown[]
          if (violations.length) throw new Error(`${violations.length} violación(es) de clave ajena`)
          insert.run(crypto.randomUUID(), sha256(sql), Date.now(), name, started)
        }).immediate()
      } catch (err) {
        throw new MigrationError(
          "FAILED",
          `La migración ${name} ha fallado y se ha deshecho: ${err instanceof Error ? err.message : String(err)}`,
          name,
          { cause: err },
        )
      } finally {
        db.pragma("foreign_keys = ON")
      }
      applied.push(name)
      log("info", `Migración aplicada: ${name}`)
    }
    if (opts.backupDir && fs.existsSync(opts.backupDir) && fs.statSync(opts.backupDir).isDirectory()) prunePreMigrate(opts.backupDir, log)
    return { applied, pending: [], unknown, backup, created: !existed }
  } finally {
    db.close()
  }
}
