import fs from "node:fs"
import path from "node:path"
import Database from "better-sqlite3"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { verifyPassword } from "@/server/auth/passwords"
import { createTestDb, makeUser, testConfig, type TestDb } from "../../../test/helpers"
import type { AppConfig } from "@/server/config/schema"
import { bufferIO } from "./io"
import { runCli } from "./index"

const REPO = path.resolve(__dirname, "../../..")

let db: TestDb
let config: AppConfig

beforeEach(async () => {
  db = await createTestDb()
  config = testConfig({
    mode: "portable", dev: false, appDir: REPO, dataDir: db.dir, dbFile: db.dbFile,
    backupDir: path.join(db.dir, "backups"), captureDir: path.join(db.dir, "consoles"),
  })
})
afterEach(async () => { await db.cleanup() })

async function cli(args: string[], stdin = "", tty = false) {
  const io = bufferIO({ stdin, tty })
  const code = await runCli("user", args, { io, loadConfig: () => config, bcryptRounds: 4 })
  return { code, out: io.stdout, err: io.stderr }
}
const user = (username: string) => db.prisma.user.findUniqueOrThrow({ where: { username } })
function cliAudit(): string[] {
  const d = new Database(db.dbFile, { readonly: true })
  try {
    return (d.prepare(`SELECT action, actorKind, actorName, targetName FROM "AuditEvent" WHERE actorKind = 'cli' ORDER BY id`).all() as Array<{ action: string; targetName: string | null }>)
      .map((r) => `${r.action}:${r.targetName ?? ""}`)
  } finally { d.close() }
}

describe("user create", () => {
  it("an admin created while setup is pending ends setup, deletes the token file and needs no password change", async () => {
    fs.writeFileSync(path.join(db.dir, "setup-token"), "AAAA-BBBB-CCCC-DDDD\n", { mode: 0o600 })
    const r = await cli(["create", "admin", "--admin", "--password-stdin"], "smoke-password-1\n")
    expect(r.err).toBe("")
    expect(r.code).toBe(0)
    expect(r.out).toContain("admin")
    const u = await user("admin")
    expect(u).toMatchObject({ isAdmin: true, mustChangePassword: false, disabled: false, name: "admin" })
    expect(await verifyPassword("smoke-password-1", u.passwordHash)).toBe(true)
    const s = await db.prisma.settings.findUniqueOrThrow({ where: { id: "global" } })
    expect(s.setupCompletedAt).not.toBeNull()
    expect(fs.existsSync(path.join(db.dir, "setup-token"))).toBe(false)
    expect(cliAudit()).toContain("user.create:admin")
  })

  it("a non-admin never ends setup and must change the password; --name is kept", async () => {
    const r = await cli(["create", "operador", "--name", "Operador Uno", "--password-stdin"], "otra-clave-12\n")
    expect(r.code).toBe(0)
    expect(await user("operador")).toMatchObject({ isAdmin: false, mustChangePassword: true, name: "Operador Uno" })
    const s = await db.prisma.settings.findUnique({ where: { id: "global" } })
    expect(s?.setupCompletedAt ?? null).toBeNull()
  })

  it("an admin created after setup must change the password", async () => {
    await db.prisma.settings.upsert({ where: { id: "global" }, create: { setupCompletedAt: new Date() }, update: { setupCompletedAt: new Date() } })
    expect((await cli(["create", "segundo", "--admin", "--password-stdin"], "segunda-clave-1\n")).code).toBe(0)
    expect(await user("segundo")).toMatchObject({ isAdmin: true, mustChangePassword: true })
  })

  it("validation: bad username or password → exit 2; duplicate → exit 1; no password source without a TTY → exit 2", async () => {
    expect((await cli(["create", "A!", "--password-stdin"], "valid-password-1\n")).code).toBe(2)
    const short = await cli(["create", "ana", "--password-stdin"], "corta\n")
    expect(short.code).toBe(2)
    expect(short.err).toContain("Mínimo 10 caracteres")
    expect((await cli(["create", "ana", "--password-stdin"], "ana\n")).code).toBe(2)
    expect((await cli(["create", "anaana1234", "--password-stdin"], "anaana1234\n")).code).toBe(2)
    expect((await cli(["create", "ana", "--password-stdin"], "valid-password-1\n")).code).toBe(0)
    const dup = await cli(["create", "ana", "--password-stdin"], "valid-password-1\n")
    expect(dup.code).toBe(1)
    expect(dup.err).toContain("Ya existe")
    expect((await cli(["create", "luis"])).code).toBe(2)
  })

  it("prompts twice on a TTY and refuses when the entries differ", async () => {
    const io = bufferIO({ tty: true, answers: ["clave-de-prueba-1", "clave-de-prueba-1"] })
    expect(await runCli("user", ["create", "tty"], { io, loadConfig: () => config, bcryptRounds: 4 })).toBe(0)
    expect(io.prompts).toEqual([{ q: "Contraseña: ", hidden: true }, { q: "Repite la contraseña: ", hidden: true }])
    const io2 = bufferIO({ tty: true, answers: ["clave-de-prueba-1", "clave-de-prueba-2"] })
    expect(await runCli("user", ["create", "tty2"], { io: io2, loadConfig: () => config, bcryptRounds: 4 })).toBe(1)
    expect(io2.stderr).toContain("no coinciden")
  })
})

describe("password reset, enable, disable, set-admin", () => {
  it("reset-password sets mustChangePassword and bumps sessionVersion; --generate prints the new password once", async () => {
    await makeUser(db.prisma, { username: "ana", sessionVersion: 3 })
    expect((await cli(["reset-password", "ana", "--password-stdin"], "nueva-clave-12\n")).code).toBe(0)
    let u = await user("ana")
    expect(u).toMatchObject({ mustChangePassword: true, sessionVersion: 4 })
    expect(await verifyPassword("nueva-clave-12", u.passwordHash)).toBe(true)

    const g = await cli(["reset-password", "ana", "--generate"])
    expect(g.code).toBe(0)
    const pw = /Nueva contraseña: (\S+)/.exec(g.out)?.[1] ?? ""
    expect(pw).toHaveLength(16)
    u = await user("ana")
    expect(u.sessionVersion).toBe(5)
    expect(await verifyPassword(pw, u.passwordHash)).toBe(true)
    expect((await cli(["reset-password", "ana", "--generate", "--password-stdin"], "x\n")).code).toBe(2)
    expect(cliAudit().filter((a) => a === "user.password.reset:ana")).toHaveLength(2)
  })

  it("disable bumps sessionVersion; enable and set-admin do not", async () => {
    await makeUser(db.prisma, { username: "admin", isAdmin: true })
    await makeUser(db.prisma, { username: "ana", sessionVersion: 1 })
    expect((await cli(["disable", "ana"])).code).toBe(0)
    expect(await user("ana")).toMatchObject({ disabled: true, sessionVersion: 2 })
    expect((await cli(["enable", "ana"])).code).toBe(0)
    expect(await user("ana")).toMatchObject({ disabled: false, sessionVersion: 2 })
    expect((await cli(["set-admin", "ana", "on"])).code).toBe(0)
    expect(await user("ana")).toMatchObject({ isAdmin: true, sessionVersion: 2 })
    expect((await cli(["set-admin", "ana", "off"])).code).toBe(0)
    expect(await user("ana")).toMatchObject({ isAdmin: false, sessionVersion: 2 })
    expect(cliAudit()).toEqual(["user.disable:ana", "user.enable:ana", "user.update:ana", "user.update:ana"])
  })

  it("set-admin on ends a pending setup", async () => {
    await makeUser(db.prisma, { username: "ana" })
    expect((await cli(["set-admin", "ana", "on"])).code).toBe(0)
    expect((await db.prisma.settings.findUniqueOrThrow({ where: { id: "global" } })).setupCompletedAt).not.toBeNull()
  })

  it("refuses to disable or demote the last enabled admin", async () => {
    await makeUser(db.prisma, { username: "jefa", isAdmin: true })
    await makeUser(db.prisma, { username: "viejo", isAdmin: true, disabled: true })
    const d = await cli(["disable", "jefa"])
    expect(d.code).toBe(1)
    expect(d.err).toContain("último administrador")
    expect((await cli(["set-admin", "jefa", "off"])).code).toBe(1)
    expect(await user("jefa")).toMatchObject({ isAdmin: true, disabled: false, sessionVersion: 1 })
    // a disabled admin may be demoted
    expect((await cli(["set-admin", "viejo", "off"])).code).toBe(0)
  })

  it("unknown user → exit 1; bad set-admin value → exit 2", async () => {
    expect((await cli(["disable", "nadie"])).code).toBe(1)
    await makeUser(db.prisma, { username: "ana" })
    expect((await cli(["set-admin", "ana", "quizá"])).code).toBe(2)
  })
})

describe("user list and guards", () => {
  it("lists users", async () => {
    await makeUser(db.prisma, { username: "admin", isAdmin: true })
    await makeUser(db.prisma, { username: "ana", disabled: true })
    const r = await cli(["list"])
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/admin\s+.*sí/)
    expect(r.out).toMatch(/ana\s+.*desactivado/)
  })

  it("no subcommand → usage (exit 2); a missing database → exit 1 and nothing is created", async () => {
    expect((await cli([])).code).toBe(2)
    const dir = path.join(db.dir, "vacío")
    fs.mkdirSync(dir)
    config = { ...config, dataDir: dir, dbFile: path.join(dir, "relay-manager.db") }
    const r = await cli(["list"])
    expect(r.code).toBe(1)
    expect(r.err).toContain("La base de datos no existe")
    expect(fs.readdirSync(dir)).toEqual([])
  })
})
