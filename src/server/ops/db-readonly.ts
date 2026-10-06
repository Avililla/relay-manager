// Read-only access to the database for diagnostics (doctor, setup-token, health) that never leaves files behind.
//
// SQLite opens a WAL database read-only by creating `<db>-wal` and `<db>-shm` when they do not exist, and a read-only
// connection never removes them on close. On a stopped server that leaves a 0-byte -wal and a -shm next to the DB
// (owned by whoever ran the command). better-sqlite3 is built without URI filenames, so `immutable=1` / `mode=ro`
// are not available. Instead:
// - side files present (a running server, or one that stopped uncleanly and whose WAL must be read): read the file in
//   place; nothing new is created;
// - no side files (a cleanly stopped server, so the main file is complete): read a private copy in a 0700 temp dir,
//   which is removed afterwards.
// Connections opened here are `query_only`.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import Database from "better-sqlite3"

const SIDE_FILES = ["-wal", "-shm", "-journal"] as const

/** True when SQLite side files exist next to `dbFile` (a server has it open, or it stopped uncleanly). */
export function hasSideFiles(dbFile: string): boolean {
  return SIDE_FILES.some((s) => fs.existsSync(dbFile + s))
}

interface Readable { file: string; cleanup(): void }

/** The file to read: `dbFile` itself, or a private copy when reading it in place would create side files. */
function readableFile(dbFile: string): Readable {
  const inPlace: Readable = { file: dbFile, cleanup: () => undefined }
  // A missing file: callers get the usual "unable to open" error for the real path; nothing is copied.
  if (hasSideFiles(dbFile) || !fs.existsSync(dbFile)) return inPlace
  let dir: string | null = null
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-manager-ro-"))
    const copy = path.join(dir, path.basename(dbFile))
    fs.copyFileSync(dbFile, copy)
    fs.chmodSync(copy, 0o600)
    const owned = dir
    return { file: copy, cleanup: () => fs.rmSync(owned, { recursive: true, force: true }) }
  } catch {
    // No room or no temp dir: fall back to reading in place (SQLite may then leave -wal/-shm, as before).
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
    return inPlace
  }
}

function open(file: string): Database.Database {
  const db = new Database(file, { readonly: true, fileMustExist: true })
  try {
    db.pragma("query_only = ON")
    db.pragma("busy_timeout = 2000")
  } catch (err) {
    db.close()
    throw err
  }
  return db
}

/**
 * Runs `fn` on a read-only connection to `dbFile` and closes it. Throws when the file cannot be opened (callers check
 * existence first). Never creates or modifies anything next to `dbFile` on a stopped server.
 */
export function withReadOnlyDb<T>(dbFile: string, fn: (db: Database.Database) => T): T {
  const r = readableFile(dbFile)
  try {
    const db = open(r.file)
    try { return fn(db) } finally { db.close() }
  } finally {
    r.cleanup()
  }
}

/** Like {@link withReadOnlyDb} for code that opens the file itself (the migration runner's read-only dry run). */
export async function withReadOnlyDbFile<T>(dbFile: string, fn: (file: string) => Promise<T>): Promise<T> {
  const r = readableFile(dbFile)
  try {
    return await fn(r.file)
  } finally {
    r.cleanup()
  }
}
