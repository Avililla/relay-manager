import fs from "node:fs"
import path from "node:path"
import Database from "better-sqlite3"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { acquireInstanceLock } from "@/server/boot/instance-lock"
import { createTestDb, type TestDb } from "../../../test/helpers"
import { createBackupStore } from "./backup"
import { restoreBackup, RestoreError } from "./restore"

const CLI = { kind: "cli", id: null, name: "cli" } as const

let db: TestDb
let backupDir: string

beforeEach(async () => {
  db = await createTestDb()
  backupDir = path.join(db.dir, "backups")
})
afterEach(async () => { await db.cleanup() })

function roleNames(file: string): string[] {
  const d = new Database(file, { readonly: true })
  try {
    return (d.prepare(`SELECT name FROM "Role" ORDER BY name`).all() as Array<{ name: string }>).map((r) => r.name)
  } finally { d.close() }
}
async function addRole(name: string) {
  await db.prisma.role.create({ data: { name } })
}
function opts(source: string, extra: Partial<Parameters<typeof restoreBackup>[0]> = {}): Parameters<typeof restoreBackup>[0] {
  return { dataDir: db.dir, dbFile: db.dbFile, backupDir, appVersion: "2.0.0", source, actor: CLI, ...extra }
}
function auditActions(file: string): string[] {
  const d = new Database(file, { readonly: true })
  try {
    return (d.prepare(`SELECT action, actorKind FROM "AuditEvent" ORDER BY id`).all() as Array<{ action: string; actorKind: string }>)
      .map((r) => `${r.actorKind}:${r.action}`)
  } finally { d.close() }
}

describe("restore", () => {
  it("refuses while a server holds the instance lock (exit 5) and changes nothing", async () => {
    await addRole("antes")
    const b = await createBackupStore({ dbFile: db.dbFile, backupDir, appVersion: "2.0.0", audit: () => {} }).create("manual", CLI)
    const lock = acquireInstanceLock(db.dir)
    try {
      const err = await restoreBackup(opts(b.name)).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(RestoreError)
      expect((err as RestoreError).exitCode).toBe(5)
      expect((err as Error).message).toContain("Detén el servicio antes de restaurar")
    } finally { lock.release() }
  })

  it("copies into <dataDir>/.restore-*, verifies it, takes a pre-restore backup, drops -wal/-shm and swaps it in", async () => {
    await addRole("antes")
    const store = createBackupStore({ dbFile: db.dbFile, backupDir, appVersion: "2.0.0", audit: () => {} })
    const b = await store.create("manual", CLI)
    await addRole("después")
    // Leave -wal/-shm files next to the DB, as after a power cut.
    const other = new Database(db.dbFile)
    other.prepare(`SELECT 1`).get()
    expect(fs.existsSync(db.dbFile + "-wal")).toBe(true)
    const wal = fs.readFileSync(db.dbFile + "-wal")
    const shm = fs.readFileSync(db.dbFile + "-shm")
    await db.prisma.$disconnect()
    other.close()
    fs.writeFileSync(db.dbFile + "-wal", wal)
    fs.writeFileSync(db.dbFile + "-shm", shm)

    let tmpSeen: string | null = null
    const res = await restoreBackup(opts(b.name, {
      hooks: {
        beforeSwap: (tmp) => {
          tmpSeen = tmp
          expect(path.dirname(tmp)).toBe(db.dir)
          expect(path.basename(tmp)).toMatch(/^\.restore-\d{8}T\d{6}Z\.db$/)
          expect(fs.existsSync(tmp)).toBe(true)
          expect(fs.existsSync(db.dbFile + "-wal")).toBe(false)
          expect(fs.existsSync(db.dbFile + "-shm")).toBe(false)
        },
      },
    }))
    expect(tmpSeen).not.toBeNull()
    expect(res.restored).toBe(b.name)
    expect(res.preRestore).toMatch(/-pre-restore\.db$/)
    expect(roleNames(db.dbFile)).toEqual(["antes"])
    expect(roleNames(path.join(backupDir, res.preRestore ?? ""))).toEqual(["antes", "después"])
    expect(fs.statSync(db.dbFile).mode & 0o777).toBe(0o640)
    expect(fs.readdirSync(db.dir).filter((f) => f.startsWith(".restore-"))).toEqual([])
    const d = new Database(db.dbFile, { readonly: true })
    expect(d.pragma("integrity_check", { simple: true })).toBe("ok")
    d.close()
    expect(auditActions(db.dbFile)).toContain("cli:backup.restore")
  })

  it("refuses a corrupt source and leaves the current DB untouched", async () => {
    await addRole("actual")
    fs.mkdirSync(backupDir, { recursive: true })
    const bad = "relay-manager-20260923T101500Z-manual.db"
    fs.writeFileSync(path.join(backupDir, bad), Buffer.alloc(8192, 7))
    const err = await restoreBackup(opts(bad)).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RestoreError)
    expect((err as RestoreError).exitCode).toBe(1)
    expect(roleNames(db.dbFile)).toEqual(["actual"])
    expect(fs.readdirSync(db.dir).filter((f) => f.startsWith(".restore-"))).toEqual([])
  })

  it("an unknown name → NOT_FOUND; a path is first copied into backupDir as -import.db", async () => {
    const e1 = await restoreBackup(opts("relay-manager-20200101T000000Z-manual.db")).catch((e: unknown) => e)
    expect(e1).toBeInstanceOf(RestoreError)
    await addRole("importado")
    const external = path.join(db.dir, "..", `${path.basename(db.dir)}-ext.db`)
    const src = new Database(db.dbFile, { readonly: true })
    await src.backup(external)
    src.close()
    await db.prisma.role.deleteMany({})
    await db.prisma.$disconnect()
    try {
      const res = await restoreBackup(opts(external))
      expect(res.restored).toMatch(/^relay-manager-\d{8}T\d{6}Z-import\.db$/)
      expect(fs.existsSync(path.join(backupDir, res.restored))).toBe(true)
      expect(roleNames(db.dbFile)).toEqual(["importado"])
    } finally { fs.rmSync(external, { force: true }) }
  })

  it("does nothing when the confirmation is declined", async () => {
    await addRole("antes")
    const b = await createBackupStore({ dbFile: db.dbFile, backupDir, appVersion: "2.0.0", audit: () => {} }).create("manual", CLI)
    await addRole("después")
    const err = await restoreBackup(opts(b.name, { confirm: async (info) => { expect(info.name).toBe(b.name); return false } })).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RestoreError)
    expect((err as RestoreError).code).toBe("ABORTED")
    expect(roleNames(db.dbFile)).toEqual(["antes", "después"])
  })
})
