import fs from "node:fs"
import path from "node:path"
import Database from "better-sqlite3"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DomainError } from "@/server/errors"
import type { AuditInput } from "@/server/runtime/types"
import { createTestDb, MIGRATIONS_DIR, type TestDb } from "../../../test/helpers"
import {
  backupGroup, createBackupStore, createDailyBackupScheduler, dailyBackupDue, isValidBackupLabel, parseBackupName,
} from "./backup"

const CLI = { kind: "cli", id: null, name: "cli" } as const

let db: TestDb
let backupDir: string
let audits: AuditInput[]

beforeEach(async () => {
  db = await createTestDb()
  backupDir = path.join(db.dir, "backups")
  audits = []
})
afterEach(async () => {
  vi.useRealTimers()
  await db.cleanup()
})

function store(now?: () => Date, daily = 14) {
  return createBackupStore({
    dbFile: db.dbFile, backupDir, appVersion: "2.0.0",
    audit: (i) => { audits.push(i) },
    now, retention: () => ({ daily }),
  })
}

/** Writes an empty backup file (+ sidecar) with the given name, as if an older backup existed. */
function fakeBackup(name: string, label: string, createdAt: string) {
  fs.mkdirSync(backupDir, { recursive: true })
  fs.writeFileSync(path.join(backupDir, name), "x")
  fs.writeFileSync(path.join(backupDir, name.replace(/\.db$/, ".json")),
    JSON.stringify({ createdAt, label, appVersion: "2.0.0", migrations: [], sizeBytes: 1 }))
}

describe("labels and names", () => {
  it("accepts the §4.14 labels only", () => {
    for (const l of ["manual", "daily", "pre-migrate", "pre-restore", "import", "portable", "pre-upgrade-1.0.0-to-2.0.0", "pre-upgrade-2.0.0-rc.1-to-2.0.0"]) {
      expect(isValidBackupLabel(l), l).toBe(true)
    }
    for (const l of ["", "../x", "otra", "pre-upgrade-", "pre-upgrade-1.0.0", "manual/x", "daily ", "pre-upgrade-a b-to-c"]) {
      expect(isValidBackupLabel(l), l).toBe(false)
    }
  })

  it("parses names and groups labels for retention", () => {
    expect(parseBackupName("relay-manager-20260923T020000Z-daily.db")).toEqual({
      name: "relay-manager-20260923T020000Z-daily.db", label: "daily", createdAt: "2026-09-23T02:00:00.000Z",
    })
    expect(parseBackupName("relay-manager-20260923T020000Z-daily.json")).toBeNull()
    expect(parseBackupName("../relay-manager-20260923T020000Z-daily.db")).toBeNull()
    expect(backupGroup("daily")).toBe("daily")
    expect(backupGroup("daily-2")).toBe("daily")
    expect(backupGroup("pre-migrate-3")).toBe("pre-migrate")
    expect(backupGroup("pre-upgrade-1.0.0-to-2.0.0")).toBe("pre-upgrade")
    expect(backupGroup("pre-restore")).toBe("pre-restore")
    expect(backupGroup("manual")).toBeNull()
    expect(backupGroup("import")).toBeNull()
    expect(backupGroup("portable")).toBeNull()
  })
})

describe("create", () => {
  it("makes an online copy while another connection writes (WAL), with sidecar, mode 0640 and audit", async () => {
    const writer = new Database(db.dbFile)
    writer.pragma("busy_timeout = 5000")
    const insert = writer.prepare(`INSERT INTO "Role" (id, name, createdAt, updatedAt) VALUES (?, ?, ?, ?)`)
    let n = 0
    const iso = new Date().toISOString()
    for (; n < 50; n++) insert.run(`r${n}`, `rol ${n}`, iso, iso)
    const timer = setInterval(() => { insert.run(`r${n}`, `rol ${n}`, iso, iso); n++ }, 1)
    try {
      const dto = await store().create("manual", CLI)
      expect(dto.name).toMatch(/^relay-manager-\d{8}T\d{6}Z-manual\.db$/)
      expect(dto.label).toBe("manual")
      expect(dto.appVersion).toBe("2.0.0")
      const file = path.join(backupDir, dto.name)
      expect(fs.statSync(file).mode & 0o777).toBe(0o640)
      expect(dto.sizeBytes).toBe(fs.statSync(file).size)

      const copy = new Database(file, { readonly: true })
      expect(copy.pragma("integrity_check", { simple: true })).toBe("ok")
      expect(copy.pragma("journal_mode", { simple: true })).toBe("delete")
      const roles = (copy.prepare(`SELECT count(*) AS c FROM "Role"`).get() as { c: number }).c
      copy.close()
      expect(roles).toBeGreaterThanOrEqual(50)

      const sidecarFile = file.replace(/\.db$/, ".json")
      expect(fs.statSync(sidecarFile).mode & 0o777).toBe(0o640)
      const sidecar = JSON.parse(fs.readFileSync(sidecarFile, "utf8")) as Record<string, unknown>
      expect(sidecar).toMatchObject({ label: "manual", appVersion: "2.0.0", migrations: fs.readdirSync(MIGRATIONS_DIR).filter((d) => fs.existsSync(path.join(MIGRATIONS_DIR, d, "migration.sql"))).sort(), sizeBytes: dto.sizeBytes })
      expect(typeof sidecar.createdAt).toBe("string")
      // no temporary file left behind
      expect(fs.readdirSync(backupDir).sort()).toEqual([dto.name, dto.name.replace(/\.db$/, ".json")].sort())
      expect(audits).toHaveLength(1)
      expect(audits[0]).toMatchObject({ action: "backup.create", actor: CLI, target: { type: "backup", name: dto.name } })
    } finally {
      clearInterval(timer)
      // the writer never failed with SQLITE_BUSY while the copy ran
      insert.run(`r${n}`, `rol ${n}`, iso, iso)
      writer.close()
    }
  })

  it("serialises concurrent calls; the same second gets -2, -3", async () => {
    const fixed = new Date("2026-09-23T10:15:00.000Z")
    const s = store(() => fixed)
    const res = await Promise.all([s.create("manual", CLI), s.create("manual", CLI), s.create("manual", CLI)])
    expect(res.map((r) => r.name).sort()).toEqual([
      "relay-manager-20260923T101500Z-manual-2.db",
      "relay-manager-20260923T101500Z-manual-3.db",
      "relay-manager-20260923T101500Z-manual.db",
    ])
    expect(res.every((r) => r.label === "manual")).toBe(true)
  })

  it("refuses an invalid label and a missing database", async () => {
    await expect(store().create("../../etc", CLI)).rejects.toMatchObject({ code: "VALIDATION" })
    const s = createBackupStore({ dbFile: path.join(db.dir, "none.db"), backupDir, appVersion: "2.0.0", audit: () => {} })
    await expect(s.create("manual", CLI)).rejects.toBeInstanceOf(DomainError)
    expect(fs.existsSync(path.join(db.dir, "none.db"))).toBe(false)
  })
})

describe("list, resolvePath and remove", () => {
  it("lists newest first with sidecar data; resolvePath rejects anything but a backup name", async () => {
    fakeBackup("relay-manager-20260920T020000Z-daily.db", "daily", "2026-09-20T02:00:00.000Z")
    fakeBackup("relay-manager-20260922T020000Z-daily.db", "daily", "2026-09-22T02:00:00.000Z")
    fs.writeFileSync(path.join(backupDir, "otro.db"), "x")
    fs.writeFileSync(path.join(backupDir, "relay-manager-20260921T020000Z-manual.db"), "xy") // no sidecar
    const s = store()
    const list = await s.list()
    expect(list.map((b) => b.name)).toEqual([
      "relay-manager-20260922T020000Z-daily.db",
      "relay-manager-20260921T020000Z-manual.db",
      "relay-manager-20260920T020000Z-daily.db",
    ])
    expect(list[1]).toEqual({ name: "relay-manager-20260921T020000Z-manual.db", label: "manual", createdAt: "2026-09-21T02:00:00.000Z", sizeBytes: 2, appVersion: null })
    expect(s.resolvePath("relay-manager-20260922T020000Z-daily.db")).toBe(path.join(backupDir, "relay-manager-20260922T020000Z-daily.db"))
    expect(s.resolvePath("../relay-manager.db")).toBeNull()
    expect(s.resolvePath("otro.db")).toBeNull()
    expect(s.resolvePath("relay-manager-20260101T000000Z-manual.db")).toBeNull() // missing
  })

  it("remove deletes the file and its sidecar and audits backup.delete", async () => {
    fakeBackup("relay-manager-20260920T020000Z-daily.db", "daily", "2026-09-20T02:00:00.000Z")
    const s = store()
    await s.remove("relay-manager-20260920T020000Z-daily.db", CLI)
    expect(fs.readdirSync(backupDir)).toEqual([])
    expect(audits[0]).toMatchObject({ action: "backup.delete", target: { type: "backup", name: "relay-manager-20260920T020000Z-daily.db" } })
    await expect(s.remove("relay-manager-20260920T020000Z-daily.db", CLI)).rejects.toMatchObject({ code: "NOT_FOUND" })
  })
})

describe("prune", () => {
  it("keeps backupRetentionCount daily, 5 of each pre-* group, and never prunes manual/import/portable", async () => {
    for (let d = 1; d <= 9; d++) fakeBackup(`relay-manager-202609${String(d).padStart(2, "0")}T020000Z-daily.db`, "daily", `2026-09-0${d}T02:00:00.000Z`)
    for (let d = 1; d <= 7; d++) fakeBackup(`relay-manager-202608${String(d).padStart(2, "0")}T020000Z-pre-migrate.db`, "pre-migrate", `2026-08-0${d}T02:00:00.000Z`)
    for (let d = 1; d <= 6; d++) fakeBackup(`relay-manager-202607${String(d).padStart(2, "0")}T020000Z-pre-upgrade-1.${d}.0-to-2.0.0.db`, `pre-upgrade-1.${d}.0-to-2.0.0`, `2026-07-0${d}T02:00:00.000Z`)
    for (let d = 1; d <= 6; d++) fakeBackup(`relay-manager-202606${String(d).padStart(2, "0")}T020000Z-pre-restore.db`, "pre-restore", `2026-06-0${d}T02:00:00.000Z`)
    for (let d = 1; d <= 8; d++) fakeBackup(`relay-manager-202605${String(d).padStart(2, "0")}T020000Z-manual.db`, "manual", `2026-05-0${d}T02:00:00.000Z`)
    fakeBackup("relay-manager-20260501T020000Z-import.db", "import", "2026-05-01T02:00:00.000Z")
    fakeBackup("relay-manager-20260501T030000Z-portable.db", "portable", "2026-05-01T03:00:00.000Z")
    const s = store(undefined, 3)
    const removed = await s.prune()
    expect(removed).toBe(6 + 2 + 1 + 1)
    const names = (await s.list()).map((b) => b.name)
    expect(names.filter((n) => n.endsWith("-daily.db"))).toEqual([
      "relay-manager-20260909T020000Z-daily.db", "relay-manager-20260908T020000Z-daily.db", "relay-manager-20260907T020000Z-daily.db",
    ])
    expect(names.filter((n) => n.includes("pre-migrate"))).toHaveLength(5)
    expect(names.filter((n) => n.includes("pre-upgrade"))).toHaveLength(5)
    expect(names).not.toContain("relay-manager-20260701T020000Z-pre-upgrade-1.1.0-to-2.0.0.db")
    expect(names.filter((n) => n.includes("pre-restore"))).toHaveLength(5)
    expect(names.filter((n) => n.includes("manual"))).toHaveLength(8)
    expect(names).toContain("relay-manager-20260501T020000Z-import.db")
    expect(names).toContain("relay-manager-20260501T030000Z-portable.db")
    // sidecars go with their backups
    expect(fs.existsSync(path.join(backupDir, "relay-manager-20260901T020000Z-daily.json"))).toBe(false)
  })
})

describe("daily scheduler", () => {
  const settings = { backupDailyEnabled: true, backupDailyHour: 3 }

  it("dailyBackupDue: enabled, local hour reached and no daily backup for today's local date", () => {
    const at = (h: number) => new Date(2026, 8, 23, h, 5)
    const todayDaily = { name: "x", label: "daily", createdAt: new Date(2026, 8, 23, 3, 0).toISOString(), sizeBytes: 1, appVersion: null }
    const yesterday = { ...todayDaily, createdAt: new Date(2026, 8, 22, 3, 0).toISOString() }
    const todayManual = { ...todayDaily, label: "manual" }
    expect(dailyBackupDue({ now: at(2), ...settings, backups: [] })).toBe(false)
    expect(dailyBackupDue({ now: at(3), ...settings, backups: [] })).toBe(true)
    expect(dailyBackupDue({ now: at(3), ...settings, backups: [yesterday, todayManual] })).toBe(true)
    expect(dailyBackupDue({ now: at(9), ...settings, backups: [todayDaily] })).toBe(false)
    expect(dailyBackupDue({ now: at(9), backupDailyEnabled: false, backupDailyHour: 3, backups: [] })).toBe(false)
  })

  function scheduler(opts: { capture?: "on" | "off" | "paused-disk"; free?: number; now: Date }) {
    const s = store(() => opts.now, 2)
    const logs: string[] = []
    const sched = createDailyBackupScheduler({
      store: s,
      settings: () => settings,
      captureState: () => opts.capture ?? "on",
      freeBytes: () => opts.free ?? 100 * 1024 ** 3,
      dbBytes: () => fs.statSync(db.dbFile).size,
      now: () => opts.now,
      log: { info: (m) => logs.push(`info ${m}`), warn: (m) => logs.push(`warn ${m}`), error: (m) => logs.push(`error ${m}`) },
      intervalMs: 600_000,
    })
    return { s, sched, logs }
  }

  it("creates the daily backup when due, audits it as the system and prunes; not twice the same day", async () => {
    const now = new Date(2026, 8, 23, 4, 0)
    fakeBackup("relay-manager-20260901T020000Z-daily.db", "daily", "2026-09-01T02:00:00.000Z")
    fakeBackup("relay-manager-20260902T020000Z-daily.db", "daily", "2026-09-02T02:00:00.000Z")
    const { s, sched } = scheduler({ now })
    expect(await sched.tick()).toBe("created")
    const daily = (await s.list()).filter((b) => b.label === "daily")
    expect(daily).toHaveLength(2) // retention 2: the new one + the newest old one
    expect(audits.find((a) => a.action === "backup.create")?.actor.kind).toBe("system")
    expect(await sched.tick()).toBe("not-due")
    expect(sched.lastSkip()).toBeNull()
  })

  it("skips with a warning while capture is paused-disk or free space is below 2 × DB + 512 MiB", async () => {
    const now = new Date(2026, 8, 23, 4, 0)
    const a = scheduler({ now, capture: "paused-disk" })
    expect(await a.sched.tick()).toBe("skipped")
    expect(a.sched.lastSkip()?.reason).toBe("capture-paused")
    expect(a.logs.some((l) => l.startsWith("warn Copia diaria omitida: poco espacio libre"))).toBe(true)
    const b = scheduler({ now, free: 512 * 1024 ** 2 })
    expect(await b.sched.tick()).toBe("skipped")
    expect(b.sched.lastSkip()?.reason).toBe("low-space")
    expect(fs.existsSync(backupDir) ? fs.readdirSync(backupDir) : []).toEqual([])
  })

  it("start() runs the tick every intervalMs; stop() clears the timer", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] })
    const { sched } = scheduler({ now: new Date(2026, 8, 23, 1, 0) })
    const spy = vi.spyOn(sched, "tick")
    sched.start()
    await vi.advanceTimersByTimeAsync(600_000 * 2 + 70_000)
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2)
    sched.stop()
    const calls = spy.mock.calls.length
    await vi.advanceTimersByTimeAsync(600_000 * 3)
    expect(spy.mock.calls.length).toBe(calls)
  })
})
