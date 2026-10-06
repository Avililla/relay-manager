// Restore (§4.14; CLI only, the web UI never restores). Holds the instance lock for the whole procedure.
import fs from "node:fs"
import path from "node:path"
import Database from "better-sqlite3"
import { acquireInstanceLock, InstanceLockedError, isInstanceRunning } from "@/server/boot/instance-lock"
import { backupTimestamp } from "@/server/db/migrate"
import type { ActorRef, AuditInput } from "@/server/runtime/types"
import { BACKUP_FILE_MODE, createBackupStore, parseBackupName } from "./backup"
import { writeAuditRow } from "./audit-raw"

export type RestoreErrorCode = "LOCKED" | "NOT_FOUND" | "INVALID" | "ABORTED" | "FAILED"

export class RestoreError extends Error {
  readonly code: RestoreErrorCode
  readonly exitCode: number
  constructor(code: RestoreErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "RestoreError"
    this.code = code
    this.exitCode = code === "LOCKED" ? 5 : 1
  }
}

export interface RestoreOptions {
  dataDir: string
  dbFile: string
  backupDir: string
  appVersion: string
  /** A backup name from backupDir, or a path to a DB file (copied into backupDir as "-import.db" first). */
  source: string
  actor: ActorRef
  /** Called after the source is verified and before anything changes; false aborts. */
  confirm?: (info: { name: string; createdAt: string }) => Promise<boolean>
  audit?: (input: AuditInput, dbFile: string) => void
  now?: () => Date
  log?: (msg: string) => void
  hooks?: { beforeSwap?: (tmpFile: string) => void }
}
export interface RestoreResult { restored: string; preRestore: string | null }

export const LOCKED_MESSAGE = "Detén el servicio antes de restaurar: sudo systemctl stop relay-manager"

function isPathLike(source: string): boolean {
  return source.includes("/") || !parseBackupName(source)
}

/** Verifies a SQLite file: integrity_check = ok and it is a relay-manager DB. */
function verifyDbFile(file: string): void {
  let db: Database.Database
  try {
    db = new Database(file, { fileMustExist: true })
  } catch (err) {
    throw new RestoreError("INVALID", `No se puede abrir la copia: ${err instanceof Error ? err.message : String(err)}`)
  }
  try {
    const check = db.pragma("integrity_check", { simple: true })
    if (check !== "ok") throw new RestoreError("INVALID", `La copia no supera la comprobación de integridad (${String(check)})`)
    const tables = new Set((db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>).map((r) => r.name))
    if (!tables.has("_prisma_migrations") || !tables.has("User") || !tables.has("AuditEvent")) {
      throw new RestoreError("INVALID", "El fichero no es una base de datos de Relay Manager")
    }
  } catch (err) {
    if (err instanceof RestoreError) throw err
    throw new RestoreError("INVALID", `La copia no es una base de datos SQLite válida: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    db.close()
  }
}

function removeSqliteFile(file: string): void {
  for (const f of [file, `${file}-wal`, `${file}-shm`, `${file}-journal`]) fs.rmSync(f, { force: true })
}

export async function restoreBackup(opts: RestoreOptions): Promise<RestoreResult> {
  const now = opts.now ?? (() => new Date())
  const log = opts.log ?? (() => {})
  const audit = opts.audit ?? ((input: AuditInput, dbFile: string) => writeAuditRow(dbFile, input))

  // 1. Never while a server runs on this data dir (D37).
  if (isInstanceRunning(opts.dataDir)) throw new RestoreError("LOCKED", LOCKED_MESSAGE)
  if (!fs.existsSync(opts.dataDir)) throw new RestoreError("NOT_FOUND", `No existe el directorio de datos ${opts.dataDir}`)
  let lock: { release(): void }
  try {
    lock = acquireInstanceLock(opts.dataDir)
  } catch (err) {
    if (err instanceof InstanceLockedError) throw new RestoreError("LOCKED", LOCKED_MESSAGE, { cause: err })
    throw err
  }

  const store = createBackupStore({ dbFile: opts.dbFile, backupDir: opts.backupDir, appVersion: opts.appVersion, audit: () => {}, now })
  const tmp = path.join(opts.dataDir, `.restore-${backupTimestamp(now())}.db`)
  try {
    // 2. Resolve the source (a path is imported into backupDir first).
    let name = opts.source
    if (isPathLike(opts.source)) {
      const src = path.resolve(opts.source)
      if (!fs.existsSync(src) || !fs.statSync(src).isFile()) throw new RestoreError("NOT_FOUND", `No existe el fichero ${src}`)
      verifyDbFile(src)
      fs.mkdirSync(opts.backupDir, { recursive: true, mode: 0o750 })
      name = `relay-manager-${backupTimestamp(now())}-import.db`
      for (let i = 2; fs.existsSync(path.join(opts.backupDir, name)); i++) name = `relay-manager-${backupTimestamp(now())}-import-${i}.db`
      fs.copyFileSync(src, path.join(opts.backupDir, name))
      fs.chmodSync(path.join(opts.backupDir, name), BACKUP_FILE_MODE)
      log(`Copia importada como ${name}`)
    }
    const srcFile = store.resolvePath(name)
    if (!srcFile) throw new RestoreError("NOT_FOUND", `No existe la copia ${name} en ${opts.backupDir}`)
    const info = (await store.list()).find((b) => b.name === name)

    // Copy into the data dir (same filesystem: the final rename never fails with EXDEV) and verify it.
    removeSqliteFile(tmp)
    fs.copyFileSync(srcFile, tmp)
    verifyDbFile(tmp)

    if (opts.confirm && !(await opts.confirm({ name, createdAt: info?.createdAt ?? "" }))) {
      throw new RestoreError("ABORTED", "Cancelado: no se ha cambiado nada")
    }

    // 3. Pre-restore backup of the current DB.
    let preRestore: string | null = null
    if (fs.existsSync(opts.dbFile)) {
      preRestore = (await store.create("pre-restore", opts.actor)).name
      log(`Copia previa a la restauración: ${preRestore}`)
    }

    // 4. Drop the old WAL and shared memory, 5. swap the verified copy in.
    fs.rmSync(`${opts.dbFile}-wal`, { force: true })
    fs.rmSync(`${opts.dbFile}-shm`, { force: true })
    fs.rmSync(`${opts.dbFile}-journal`, { force: true })
    opts.hooks?.beforeSwap?.(tmp)
    fs.renameSync(tmp, opts.dbFile)
    fs.chmodSync(opts.dbFile, 0o640)
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      // As root (portable/container tests) the file takes the data dir's owner, like the rest of the data.
      const st = fs.statSync(opts.dataDir)
      fs.chownSync(opts.dbFile, st.uid, st.gid)
    }

    // 6. Audit into the restored DB.
    try {
      audit({ actor: opts.actor, action: "backup.restore", target: { type: "backup", id: null, name }, detail: { preRestore } }, opts.dbFile)
    } catch (err) {
      log(`No se pudo registrar la restauración en la auditoría: ${err instanceof Error ? err.message : String(err)}`)
    }
    return { restored: name, preRestore }
  } catch (err) {
    if (err instanceof RestoreError) throw err
    throw new RestoreError("FAILED", `La restauración ha fallado: ${err instanceof Error ? err.message : String(err)}`, { cause: err })
  } finally {
    removeSqliteFile(tmp)
    lock.release()
  }
}
