import fs from "node:fs"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { acquireInstanceLock } from "@/server/boot/instance-lock"
import type { AppConfig } from "@/server/config/schema"
import { createTestDb, testConfig, withTempDir, type TestDb } from "../../../test/helpers"
import { bufferIO } from "./io"
import { runCli } from "./index"

const REPO = path.resolve(__dirname, "../../..")
let db: TestDb
let config: AppConfig

beforeEach(async () => {
  db = await createTestDb()
  config = testConfig({
    mode: "portable", dev: false, appDir: REPO, dataDir: db.dir, dbFile: db.dbFile,
    backupDir: path.join(db.dir, "backups"), captureDir: path.join(db.dir, "consoles"), authSecret: null,
  })
})
afterEach(async () => { await db.cleanup() })

async function cli(cmd: string, args: string[], opts: { stdin?: string; tty?: boolean; answers?: string[] } = {}) {
  const io = bufferIO(opts)
  const code = await runCli(cmd, args, { io, loadConfig: () => config, bcryptRounds: 4 })
  return { code, out: io.stdout, err: io.stderr }
}

describe("dispatch", () => {
  it("unknown command → exit 2 with usage in Spanish", async () => {
    const r = await cli("volar", [])
    expect(r.code).toBe(2)
    expect(r.err).toContain("Orden desconocida: volar")
  })
  it("a configuration error → exit 2", async () => {
    const io = bufferIO()
    const code = await runCli("doctor", [], { io, loadConfig: () => { throw Object.assign(new Error("Valor no válido en RM_PORT: x"), { name: "ConfigError" }) } })
    expect(code).toBe(2)
    expect(io.stderr).toContain("Valor no válido en RM_PORT")
  })
})

describe("setup-token", () => {
  it("prints the token while setup is pending, explains a missing token, and reports completion", async () => {
    const missing = await cli("setup-token", [])
    expect(missing.code).toBe(1)
    expect(missing.err).toContain("El servidor aún no ha generado el código: inícialo")
    fs.writeFileSync(path.join(db.dir, "setup-token"), "7KQM-X2PD-9HVA-RT4C\n", { mode: 0o600 })
    const shown = await cli("setup-token", [])
    expect(shown).toMatchObject({ code: 0 })
    expect(shown.out.trim()).toBe("7KQM-X2PD-9HVA-RT4C")
    await db.prisma.settings.upsert({ where: { id: "global" }, create: { setupCompletedAt: new Date() }, update: { setupCompletedAt: new Date() } })
    const done = await cli("setup-token", [])
    expect(done.code).toBe(0)
    expect(done.out).toContain("La configuración inicial ya está completada")
  })
})

describe("backup and restore commands", () => {
  it("backup prints the file path (default label manual); --label validated", async () => {
    const r = await cli("backup", [])
    expect(r.code).toBe(0)
    const file = r.out.trim()
    expect(path.dirname(file)).toBe(config.backupDir)
    expect(path.basename(file)).toMatch(/^relay-manager-\d{8}T\d{6}Z-manual\.db$/)
    expect(fs.existsSync(file)).toBe(true)
    const up = await cli("backup", ["--label", "pre-upgrade-1.0.0-to-2.0.0"])
    expect(up.out.trim()).toMatch(/-pre-upgrade-1\.0\.0-to-2\.0\.0\.db$/)
    expect((await cli("backup", ["--label", "../x"])).code).toBe(2)
  })

  it("restore needs --yes without a TTY, refuses (exit 5) while the instance lock is held, and restores by name", async () => {
    const name = path.basename((await cli("backup", [])).out.trim())
    await db.prisma.role.create({ data: { name: "después" } })
    const noYes = await cli("restore", [name])
    expect(noYes.code).toBe(2)
    expect(noYes.err).toContain("--yes")
    const lock = acquireInstanceLock(db.dir)
    try {
      expect((await cli("restore", [name, "--yes"])).code).toBe(5)
    } finally { lock.release() }
    await db.prisma.$disconnect()
    const ok = await cli("restore", [name, "--yes"])
    expect(ok.err).toBe("")
    expect(ok.code).toBe(0)
    expect(ok.out).toContain(name)
    expect(await db.prisma.role.count()).toBe(0)
  })

  it("restore asks on a TTY and aborts on 'n'", async () => {
    const name = path.basename((await cli("backup", [])).out.trim())
    const r = await cli("restore", [name], { tty: true, answers: ["n"] })
    expect(r.code).toBe(1)
    expect(r.err).toContain("Cancelado")
  })
})

describe("config export and import (W1-C config-io)", () => {
  it("export → file; import --dry-run changes nothing; a real import seeds the built-in templates first", async () => {
    const file = path.join(db.dir, "export.json")
    const exp = await cli("config", ["export", file])
    expect(exp.code).toBe(0)
    const json = JSON.parse(fs.readFileSync(file, "utf8")) as { format: string; version: number }
    expect(json).toMatchObject({ format: "relay-manager-config", version: 1 })
    expect(fs.statSync(file).mode & 0o777).toBe(0o640)

    const dry = await cli("config", ["import", file, "--dry-run"])
    expect(dry.code).toBe(0)
    expect(dry.out).toContain("Simulación (no se ha cambiado nada)")
    expect(await db.prisma.equipmentTemplate.count()).toBe(0)

    const real = await cli("config", ["import", file])
    expect(real.code).toBe(0)
    expect(real.out).toContain("Importación completada")
    expect(await db.prisma.equipmentTemplate.count()).toBe(0) // no profile: no templates (the export had none)
  })

  it("a real import refuses while a server holds the instance lock (exit 5); bad JSON → exit 2; usage → exit 2", async () => {
    const file = path.join(db.dir, "bad.json")
    fs.writeFileSync(file, "{nope")
    expect((await cli("config", ["import", file])).code).toBe(2)
    const lock = acquireInstanceLock(db.dir)
    try {
      const r = await cli("config", ["import", file])
      expect(r.code).toBe(5)
      expect(r.err).toContain("Detén el servicio antes de importar")
    } finally { lock.release() }
    expect((await cli("config", [])).code).toBe(2)
  })
})

describe("read-only commands on a stopped DB (regression: -wal/-shm left behind)", () => {
  const sideFiles = () => fs.readdirSync(db.dir).filter((f) => /-(wal|shm|journal)$/.test(f))

  it("doctor and setup-token read a cleanly stopped WAL database without creating -wal/-shm next to it", async () => {
    await db.prisma.user.create({ data: { username: "ana", name: "Ana", passwordHash: "x" } })
    await db.prisma.$disconnect()                     // the server stops: SQLite removes its -wal and -shm
    expect(sideFiles()).toEqual([])
    const before = fs.statSync(db.dbFile).mtimeMs
    const doc = await cli("doctor", ["--json"])
    const checks = JSON.parse(doc.out) as Array<{ id: string; level: string; message: string }>
    expect(checks.find((c) => c.id === "data.db")?.message).toContain("1 usuario")
    expect((await cli("setup-token", [])).err).toContain("El servidor aún no ha generado el código")
    expect(sideFiles()).toEqual([])
    expect(fs.statSync(db.dbFile).mtimeMs).toBe(before)
  })

  it("with a running server (its -wal present) doctor still reads the rows that are only in the WAL", async () => {
    await db.prisma.user.create({ data: { username: "ana", name: "Ana", passwordHash: "x" } })
    expect(sideFiles().sort()).toEqual(["relay-manager.db-shm", "relay-manager.db-wal"])
    const doc = await cli("doctor", ["--json"])
    const checks = JSON.parse(doc.out) as Array<{ id: string; message: string }>
    expect(checks.find((c) => c.id === "data.db")?.message).toContain("1 usuario")
  })
})

describe("doctor command", () => {
  it("--json prints HealthCheckDTO[]; exit 1 only when a check fails", async () => {
    const r = await cli("doctor", ["--json"])
    const checks = JSON.parse(r.out) as Array<{ id: string; level: string }>
    expect(checks.find((c) => c.id === "data.db")).toBeDefined()
    expect(r.code).toBe(checks.some((c) => c.level === "fail") ? 1 : 0)
  })

  it("text output is Spanish with [ OK ]/[AVISO]/[FALLO]/[INFO] and a summary; nothing is created", async () => {
    const t = withTempDir("rm-doc-")
    try {
      const dataDir = path.join(t.dir, "data")
      config = { ...config, dataDir, dbFile: path.join(dataDir, "relay-manager.db"), backupDir: path.join(dataDir, "backups"), captureDir: path.join(dataDir, "consoles") }
      const r = await cli("doctor", [])
      expect(r.out).toMatch(/\[ OK \]|\[AVISO\]|\[INFO\]/)
      expect(r.out).toMatch(/\d+ fallo\(s\), \d+ aviso\(s\)/)
      expect(r.out).not.toMatch(/\x1b\[/) // no colours when not a TTY
      expect(fs.readdirSync(t.dir)).toEqual([])
    } finally { t.cleanup() }
  })
})
