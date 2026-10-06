// "Another instance runs on this data dir" is an exclusive SQLite lock (D37), never server.pid.
import fs from "node:fs"
import path from "node:path"
import Database from "better-sqlite3"

export const LOCK_FILE = ".instance-lock"

export class InstanceLockedError extends Error {
  readonly dataDir: string
  constructor(dataDir: string) {
    super(`Otra instancia usa ${dataDir}`)
    this.name = "InstanceLockedError"
    this.dataDir = dataDir
  }
}

function isBusy(err: unknown): boolean {
  const code = typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined
  return code === "SQLITE_BUSY" || code === "SQLITE_LOCKED"
}

/**
 * Opens <dataDir>/.instance-lock (0600) with better-sqlite3, busy_timeout=0, PRAGMA locking_mode=EXCLUSIVE;
 * BEGIN EXCLUSIVE; and keeps the transaction open for the life of the process. SQLITE_BUSY → InstanceLockedError.
 * The kernel drops the lock when the process dies (also after a power loss).
 */
export function acquireInstanceLock(dataDir: string): { release(): void } {
  const file = path.join(dataDir, LOCK_FILE)
  fs.closeSync(fs.openSync(file, "a", 0o600))
  try { fs.chmodSync(file, 0o600) } catch { /* not ours: doctor reports it */ }
  const db = new Database(file)
  try {
    db.pragma("busy_timeout = 0")
    db.pragma("journal_mode = MEMORY") // no -journal file next to the lock
    db.pragma("locking_mode = EXCLUSIVE")
    db.exec("BEGIN EXCLUSIVE")
  } catch (err) {
    db.close()
    if (isBusy(err)) throw new InstanceLockedError(dataDir)
    throw err
  }
  // better-sqlite3 closes a connection when it is garbage-collected, which would silently drop the lock if the
  // caller discards the handle; keep a strong reference until release().
  HELD.add(db)
  let released = false
  return {
    release() {
      if (released) return
      released = true
      HELD.delete(db)
      try { db.exec("ROLLBACK") } catch { /* already gone */ }
      db.close()
    },
  }
}

const HELD = new Set<Database.Database>()

/** Tries the same lock and releases it at once. A missing data dir or lock file → false (nothing is created). */
export function isInstanceRunning(dataDir: string): boolean {
  const file = path.join(dataDir, LOCK_FILE)
  if (!fs.existsSync(file)) return false
  let db: Database.Database
  try {
    db = new Database(file, { fileMustExist: true })
  } catch {
    return false
  }
  try {
    db.pragma("busy_timeout = 0")
    db.pragma("journal_mode = MEMORY")
    db.exec("BEGIN EXCLUSIVE")
    db.exec("ROLLBACK")
    return false
  } catch (err) {
    return isBusy(err)
  } finally {
    db.close()
  }
}
