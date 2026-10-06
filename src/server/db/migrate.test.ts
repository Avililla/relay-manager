import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import Database from "better-sqlite3"
import { afterEach, describe, expect, it, vi } from "vitest"
import { MigrationError, migrateDatabase, type MigrateOptions } from "./migrate"
import { MIGRATIONS_DIR, withTempDir } from "../../../test/helpers"

const cleanups: Array<() => void> = []
afterEach(() => { for (const c of cleanups.splice(0)) c() })

function tmp() {
  const t = withTempDir("rm-mig-")
  cleanups.push(t.cleanup)
  return t.dir
}
function writeMigration(dir: string, name: string, sql: string) {
  fs.mkdirSync(path.join(dir, name), { recursive: true })
  fs.writeFileSync(path.join(dir, name, "migration.sql"), sql)
}
const quiet: MigrateOptions["log"] = () => {}
/** Every migration of the repo, in order (the init one first). */
const ALL = fs.readdirSync(MIGRATIONS_DIR).filter((d) => fs.existsSync(path.join(MIGRATIONS_DIR, d, "migration.sql"))).sort()
function opts(o: Partial<MigrateOptions> & { dbFile: string; migrationsDir: string }): MigrateOptions {
  return { backupDir: null, appVersion: "2.0.0", log: quiet, ...o }
}
type Row = { id: string; checksum: string; finished_at: number; started_at: number; migration_name: string; applied_steps_count: number; logs: string | null; rolled_back_at: number | null }
function rows(dbFile: string): Row[] {
  const db = new Database(dbFile, { readonly: true })
  try { return db.prepare("SELECT * FROM _prisma_migrations ORDER BY migration_name").all() as Row[] } finally { db.close() }
}

const PARENT_CHILD = `
CREATE TABLE "Parent" ("id" TEXT NOT NULL PRIMARY KEY, "name" TEXT NOT NULL);
CREATE TABLE "Child" ("id" TEXT NOT NULL PRIMARY KEY, "parentId" TEXT NOT NULL,
  CONSTRAINT "Child_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Parent" ("id") ON DELETE CASCADE ON UPDATE CASCADE);
`
const REDEFINE_PARENT = `
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Parent" ("id" TEXT NOT NULL PRIMARY KEY, "name" TEXT NOT NULL, "extra" INTEGER NOT NULL DEFAULT 0);
INSERT INTO "new_Parent" ("id", "name") SELECT "id", "name" FROM "Parent";
DROP TABLE "Parent";
ALTER TABLE "new_Parent" RENAME TO "Parent";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
`

describe("migration runner", () => {
  it("applies the real init migration and writes a Prisma-compatible row", async () => {
    const dir = tmp()
    const dbFile = path.join(dir, "relay-manager.db")
    const r = await migrateDatabase(opts({ dbFile, migrationsDir: MIGRATIONS_DIR }))
    expect(r).toMatchObject({ applied: ALL, pending: [], unknown: [], backup: null, created: true })
    expect(ALL[0]).toBe("20260923000000_init")
    const [row] = rows(dbFile)
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, "20260923000000_init", "migration.sql"))
    expect(row.checksum).toBe(crypto.createHash("sha256").update(sql).digest("hex"))
    expect(row.checksum).toMatch(/^[0-9a-f]{64}$/)
    expect(row.applied_steps_count).toBe(1)
    expect(Number.isInteger(row.started_at) && row.started_at > 1_700_000_000_000).toBe(true)
    expect(Number.isInteger(row.finished_at) && row.finished_at >= row.started_at).toBe(true)
    expect(row.rolled_back_at).toBeNull()
    const db = new Database(dbFile, { readonly: true })
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal")
    db.close()
  })

  it("re-run is a no-op", async () => {
    const dir = tmp()
    const dbFile = path.join(dir, "x.db")
    await migrateDatabase(opts({ dbFile, migrationsDir: MIGRATIONS_DIR }))
    const r = await migrateDatabase(opts({ dbFile, migrationsDir: MIGRATIONS_DIR, backupDir: path.join(dir, "b") }))
    expect(r).toMatchObject({ applied: [], pending: [], created: false, backup: null })
    expect(rows(dbFile)).toHaveLength(ALL.length)
  })

  it("detects pending migrations (dry run) and applies them", async () => {
    const dir = tmp(); const mig = path.join(dir, "m")
    writeMigration(mig, "001_a", `CREATE TABLE "A" ("id" INTEGER PRIMARY KEY);`)
    const dbFile = path.join(dir, "x.db")
    await migrateDatabase(opts({ dbFile, migrationsDir: mig }))
    writeMigration(mig, "002_b", `CREATE TABLE "B" ("id" INTEGER PRIMARY KEY);`)
    const dry = await migrateDatabase(opts({ dbFile, migrationsDir: mig, dryRun: true }))
    expect(dry).toMatchObject({ applied: [], pending: ["002_b"], unknown: [] })
    expect(rows(dbFile)).toHaveLength(1)
    const real = await migrateDatabase(opts({ dbFile, migrationsDir: mig }))
    expect(real.applied).toEqual(["002_b"])
  })

  it("dryRun on a missing DB creates no file and reports every migration pending", async () => {
    const dir = tmp()
    const dbFile = path.join(dir, "data", "relay-manager.db")
    const log = vi.fn()
    const r = await migrateDatabase(opts({ dbFile, migrationsDir: MIGRATIONS_DIR, dryRun: true, backupDir: path.join(dir, "data", "backups"), log }))
    expect(r).toEqual({ applied: [], pending: ALL, unknown: [], backup: null, created: false })
    expect(fs.existsSync(path.join(dir, "data"))).toBe(false)
    expect(fs.readdirSync(dir)).toEqual([])
    expect(log).toHaveBeenCalledWith("info", "Sin base de datos: se creará al iniciar")
  })

  it("dryRun opens read-only: creates no table, no WAL, no journal", async () => {
    const dir = tmp()
    const dbFile = path.join(dir, "x.db")
    const raw = new Database(dbFile)
    raw.exec(`CREATE TABLE "T" ("id" INTEGER PRIMARY KEY)`)
    raw.close()
    const before = fs.readdirSync(dir).sort()
    const r = await migrateDatabase(opts({ dbFile, migrationsDir: MIGRATIONS_DIR, dryRun: true }))
    expect(r.pending).toEqual(ALL)
    expect(fs.readdirSync(dir).sort()).toEqual(before)
    const db = new Database(dbFile, { readonly: true })
    const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='_prisma_migrations'").get()
    expect(db.pragma("journal_mode", { simple: true })).toBe("delete")
    db.close()
    expect(t).toBeUndefined()
  })

  it("takes a pre-migrate backup (with sidecar) only when the DB already existed", async () => {
    const dir = tmp(); const mig = path.join(dir, "m"); const backupDir = path.join(dir, "backups")
    writeMigration(mig, "001_a", `CREATE TABLE "A" ("id" INTEGER PRIMARY KEY);`)
    const dbFile = path.join(dir, "x.db")
    const first = await migrateDatabase(opts({ dbFile, migrationsDir: mig, backupDir }))
    expect(first.backup).toBeNull()
    writeMigration(mig, "002_b", `CREATE TABLE "B" ("id" INTEGER PRIMARY KEY);`)
    const second = await migrateDatabase(opts({ dbFile, migrationsDir: mig, backupDir }))
    expect(second.backup).toMatch(/relay-manager-\d{8}T\d{6}Z-pre-migrate(-\d+)?\.db$/)
    expect(fs.existsSync(second.backup ?? "")).toBe(true)
    const sidecar = JSON.parse(fs.readFileSync(String(second.backup).replace(/\.db$/, ".json"), "utf8"))
    expect(sidecar).toMatchObject({ label: "pre-migrate", appVersion: "2.0.0", migrations: ["001_a"] })
    const bdb = new Database(String(second.backup), { readonly: true })
    expect(bdb.prepare("SELECT name FROM sqlite_master WHERE name='B'").get()).toBeUndefined()
    bdb.close()
  })

  it("skips the pre-migrate backup when a recent matching pre-upgrade backup exists", async () => {
    const dir = tmp(); const mig = path.join(dir, "m"); const backupDir = path.join(dir, "backups")
    writeMigration(mig, "001_a", `CREATE TABLE "A" ("id" INTEGER PRIMARY KEY);`)
    const dbFile = path.join(dir, "x.db")
    await migrateDatabase(opts({ dbFile, migrationsDir: mig }))
    fs.mkdirSync(backupDir)
    const ts = new Date(Date.now() - 10 * 60_000).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")
    fs.writeFileSync(path.join(backupDir, `relay-manager-${ts}-pre-upgrade-1.0.0-to-2.0.0.db`), "")
    writeMigration(mig, "002_b", `CREATE TABLE "B" ("id" INTEGER PRIMARY KEY);`)
    const r = await migrateDatabase(opts({ dbFile, migrationsDir: mig, backupDir }))
    expect(r.backup).toBeNull()
    expect(r.applied).toEqual(["002_b"])
    expect(fs.readdirSync(backupDir).filter((f) => f.includes("pre-migrate"))).toEqual([])
  })

  it("a failing required backup → FAILED and nothing applied", async () => {
    const dir = tmp(); const mig = path.join(dir, "m")
    writeMigration(mig, "001_a", `CREATE TABLE "A" ("id" INTEGER PRIMARY KEY);`)
    const dbFile = path.join(dir, "x.db")
    await migrateDatabase(opts({ dbFile, migrationsDir: mig }))
    writeMigration(mig, "002_b", `CREATE TABLE "B" ("id" INTEGER PRIMARY KEY);`)
    const notADir = path.join(dir, "file")
    fs.writeFileSync(notADir, "x")
    const err = await migrateDatabase(opts({ dbFile, migrationsDir: mig, backupDir: notADir })).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(MigrationError)
    expect((err as MigrationError).code).toBe("FAILED")
    expect(rows(dbFile).map((r) => r.migration_name)).toEqual(["001_a"])
  })

  it("RedefineTables trap: child rows survive a parent redefinition", async () => {
    const dir = tmp(); const mig = path.join(dir, "m")
    writeMigration(mig, "001_parent_child", PARENT_CHILD)
    const dbFile = path.join(dir, "x.db")
    await migrateDatabase(opts({ dbFile, migrationsDir: mig }))
    const raw = new Database(dbFile)
    raw.pragma("foreign_keys = ON")
    raw.exec(`INSERT INTO "Parent" VALUES ('p1','uno'); INSERT INTO "Child" VALUES ('c1','p1'), ('c2','p1');`)
    raw.close()
    writeMigration(mig, "002_redefine_parent", REDEFINE_PARENT)
    await migrateDatabase(opts({ dbFile, migrationsDir: mig }))
    const db = new Database(dbFile, { readonly: true })
    expect(db.prepare(`SELECT COUNT(*) AS n FROM "Child"`).get()).toEqual({ n: 2 })
    expect(db.prepare(`SELECT "extra" FROM "Parent"`).get()).toEqual({ extra: 0 })
    db.close()
  })

  it("an FK violation rolls back, records nothing and throws FAILED", async () => {
    const dir = tmp(); const mig = path.join(dir, "m")
    writeMigration(mig, "001_parent_child", PARENT_CHILD)
    const dbFile = path.join(dir, "x.db")
    await migrateDatabase(opts({ dbFile, migrationsDir: mig }))
    writeMigration(mig, "002_bad", `CREATE TABLE "Other" ("id" INTEGER PRIMARY KEY); INSERT INTO "Child" VALUES ('c9','missing');`)
    const err = await migrateDatabase(opts({ dbFile, migrationsDir: mig })).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(MigrationError)
    expect(err).toMatchObject({ code: "FAILED", migration: "002_bad" })
    const db = new Database(dbFile, { readonly: true })
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE name='Other'`).get()).toBeUndefined()
    expect(db.prepare(`SELECT COUNT(*) AS n FROM "Child"`).get()).toEqual({ n: 0 })
    expect(Number(db.pragma("foreign_keys", { simple: true }))).toBeGreaterThanOrEqual(0)
    db.close()
    expect(rows(dbFile).map((r) => r.migration_name)).toEqual(["001_parent_child"])
  })

  it("a recorded failed row → RECORDED_FAILURE", async () => {
    const dir = tmp()
    const dbFile = path.join(dir, "x.db")
    await migrateDatabase(opts({ dbFile, migrationsDir: MIGRATIONS_DIR }))
    const raw = new Database(dbFile)
    raw.prepare(`INSERT INTO _prisma_migrations (id, checksum, migration_name, started_at, applied_steps_count) VALUES ('x','y','20990101_broken', 1, 0)`).run()
    raw.close()
    await expect(migrateDatabase(opts({ dbFile, migrationsDir: MIGRATIONS_DIR }))).rejects.toMatchObject({ code: "RECORDED_FAILURE" })
  })

  it("an unknown applied migration → UNKNOWN_MIGRATIONS unless allowed (dry run only reports it)", async () => {
    const dir = tmp(); const mig = path.join(dir, "m")
    writeMigration(mig, "001_a", `CREATE TABLE "A" ("id" INTEGER PRIMARY KEY);`)
    writeMigration(mig, "002_b", `CREATE TABLE "B" ("id" INTEGER PRIMARY KEY);`)
    const dbFile = path.join(dir, "x.db")
    await migrateDatabase(opts({ dbFile, migrationsDir: mig }))
    fs.rmSync(path.join(mig, "002_b"), { recursive: true })
    const err = await migrateDatabase(opts({ dbFile, migrationsDir: mig })).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(MigrationError)
    expect((err as MigrationError).code).toBe("UNKNOWN_MIGRATIONS")
    expect((err as MigrationError).message).toContain("relay-manager restore")
    const allowed = await migrateDatabase(opts({ dbFile, migrationsDir: mig, allowUnknown: true }))
    expect(allowed.unknown).toEqual(["002_b"])
    const dry = await migrateDatabase(opts({ dbFile, migrationsDir: mig, dryRun: true }))
    expect(dry.unknown).toEqual(["002_b"])
  })

  it("a checksum mismatch is only a warning", async () => {
    const dir = tmp(); const mig = path.join(dir, "m")
    writeMigration(mig, "001_a", `CREATE TABLE "A" ("id" INTEGER PRIMARY KEY);`)
    const dbFile = path.join(dir, "x.db")
    await migrateDatabase(opts({ dbFile, migrationsDir: mig }))
    fs.appendFileSync(path.join(mig, "001_a", "migration.sql"), "\n-- edited\n")
    const log = vi.fn()
    const r = await migrateDatabase(opts({ dbFile, migrationsDir: mig, log }))
    expect(r.applied).toEqual([])
    expect(log.mock.calls.some(([level, msg]) => level === "warn" && String(msg).includes("001_a"))).toBe(true)
  })

  it("keeps only the 5 newest pre-migrate backups", async () => {
    const dir = tmp(); const mig = path.join(dir, "m"); const backupDir = path.join(dir, "backups")
    fs.mkdirSync(backupDir)
    for (let i = 1; i <= 6; i++) fs.writeFileSync(path.join(backupDir, `relay-manager-2026010${i}T000000Z-pre-migrate.db`), "")
    fs.writeFileSync(path.join(backupDir, `relay-manager-20260101T000000Z-pre-migrate.json`), "{}")
    fs.writeFileSync(path.join(backupDir, `relay-manager-20250101T000000Z-daily.db`), "")
    writeMigration(mig, "001_a", `CREATE TABLE "A" ("id" INTEGER PRIMARY KEY);`)
    const dbFile = path.join(dir, "x.db")
    new Database(dbFile).close()
    const r = await migrateDatabase(opts({ dbFile, migrationsDir: mig, backupDir }))
    expect(r.backup).not.toBeNull()
    const left = fs.readdirSync(backupDir).filter((f) => f.endsWith("pre-migrate.db"))
    expect(left).toHaveLength(5)
    expect(left).not.toContain("relay-manager-20260101T000000Z-pre-migrate.db")
    expect(left).not.toContain("relay-manager-20260102T000000Z-pre-migrate.db")
    expect(fs.existsSync(path.join(backupDir, "relay-manager-20260101T000000Z-pre-migrate.json"))).toBe(false)
    expect(fs.existsSync(path.join(backupDir, "relay-manager-20250101T000000Z-daily.db"))).toBe(true)
  })

  it("upgrades a 2.0.0 database (init only) with the accesses migration, keeping every row", async () => {
    const dir = tmp()
    const initOnly = path.join(dir, "m")
    fs.mkdirSync(path.join(initOnly, ALL[0]), { recursive: true })
    fs.copyFileSync(path.join(MIGRATIONS_DIR, ALL[0], "migration.sql"), path.join(initOnly, ALL[0], "migration.sql"))
    const dbFile = path.join(dir, "relay-manager.db")
    await migrateDatabase(opts({ dbFile, migrationsDir: initOnly }))
    const raw = new Database(dbFile)
    raw.exec(`INSERT INTO "Equipment" ("id","name","position","createdAt","updatedAt") VALUES ('e1','Equipo A #01',0,0,0);
      INSERT INTO "SerialConsole" ("id","equipmentId","position","key","label","createdAt","updatedAt") VALUES ('c1','e1',0,'UART0','UART0',0,0);`)
    raw.close()
    const r = await migrateDatabase(opts({ dbFile, migrationsDir: MIGRATIONS_DIR, backupDir: path.join(dir, "backups") }))
    expect(r.applied).toEqual(ALL.slice(1))
    expect(r.backup).toMatch(/pre-migrate/)
    const db = new Database(dbFile)
    expect(db.prepare(`SELECT count(*) AS n FROM "SerialConsole"`).get()).toEqual({ n: 1 })
    db.exec(`INSERT INTO "EquipmentAccess" ("id","equipmentId","position","key","label","kind","port","consoleId","updatedAt") VALUES ('a1','e1',0,'SERIE0','Serie SEC','serial',3203,'c1',0);
      INSERT INTO "CableLabel" ("id","kind","identity","name","updatedAt") VALUES ('l1','jtag','210299AAAA01','JTAG-01',0);`)
    db.pragma("foreign_keys = ON")
    db.exec(`DELETE FROM "SerialConsole" WHERE "id" = 'c1'`)
    expect(db.prepare(`SELECT "consoleId" FROM "EquipmentAccess" WHERE "id" = 'a1'`).get()).toEqual({ consoleId: null })
    db.exec(`DELETE FROM "Equipment" WHERE "id" = 'e1'`)
    expect(db.prepare(`SELECT count(*) AS n FROM "EquipmentAccess"`).get()).toEqual({ n: 0 })
    db.close()
  })

  it("user_theme: upgrades a 2.2.0 database with users; only ADD COLUMN, the column is null and every row and link stays", async () => {
    const themeMig = ALL.find((n) => n.endsWith("_user_theme"))
    expect(themeMig, "prisma/migrations/*_user_theme").toBeDefined()
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, String(themeMig), "migration.sql"), "utf8")
    const statements = sql.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("--"))
    expect(statements).toEqual([`ALTER TABLE "User" ADD COLUMN "theme" TEXT;`])

    // A database created at HEAD before this change: every earlier migration.
    const dir = tmp()
    const before = path.join(dir, "m")
    for (const name of ALL.filter((n) => n !== themeMig)) {
      fs.mkdirSync(path.join(before, name), { recursive: true })
      fs.copyFileSync(path.join(MIGRATIONS_DIR, name, "migration.sql"), path.join(before, name, "migration.sql"))
    }
    const dbFile = path.join(dir, "relay-manager.db")
    await migrateDatabase(opts({ dbFile, migrationsDir: before }))
    const raw = new Database(dbFile)
    raw.exec(`INSERT INTO "User" ("id","username","name","passwordHash","isAdmin","updatedAt") VALUES ('u1','ana','Ana','x',1,0),('u2','blas','Blas','x',0,0);
      INSERT INTO "Role" ("id","name","updatedAt") VALUES ('r1','Integración',0);
      INSERT INTO "_UserRoles" ("A","B") VALUES ('r1','u2');
      INSERT INTO "Equipment" ("id","name","position","createdAt","updatedAt","reservedById") VALUES ('e1','Equipo A #01',0,0,0,'u2');`)
    raw.close()

    const r = await migrateDatabase(opts({ dbFile, migrationsDir: MIGRATIONS_DIR, backupDir: path.join(dir, "backups") }))
    expect(r.applied).toEqual([themeMig])
    const db = new Database(dbFile)
    const cols = db.prepare(`PRAGMA table_info("User")`).all() as Array<{ name: string; notnull: number; dflt_value: unknown }>
    expect(cols.find((c) => c.name === "theme")).toMatchObject({ notnull: 0, dflt_value: null })
    expect(db.prepare(`SELECT "id","username","isAdmin","theme" FROM "User" ORDER BY "id"`).all()).toEqual([
      { id: "u1", username: "ana", isAdmin: 1, theme: null },
      { id: "u2", username: "blas", isAdmin: 0, theme: null },
    ])
    expect(db.prepare(`SELECT count(*) AS n FROM "_UserRoles"`).get()).toEqual({ n: 1 })
    expect(db.prepare(`SELECT "reservedById" FROM "Equipment" WHERE "id" = 'e1'`).get()).toEqual({ reservedById: "u2" })
    expect(db.pragma("foreign_key_check")).toEqual([])
    db.close()
  })
})
