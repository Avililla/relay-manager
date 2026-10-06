import fs from "node:fs"
import path from "node:path"
import Database from "better-sqlite3"
import { afterEach, describe, expect, it } from "vitest"
import { TemplateSpecSchema } from "@/lib/contracts/templates"
import { createPrismaClient } from "@/server/db/client"
import { migrateDatabase } from "@/server/db/migrate"
import { createTestDb, MIGRATIONS_DIR, type TestDb } from "../../../test/helpers"
import { withTempDir } from "../../../test/helpers/temp"
import { syncProfileTemplates } from "./sync"
import { loadProfileTemplates } from "./templates"

const LINE = { baudRate: 115200, dataBits: 8, parity: "none", stopBits: 1, flowControl: "none" }
const tpl = (key: string, name: string, extra: Record<string, unknown> = {}) => ({
  key, name, namePattern: `${name} #{nn}`, consoles: [{ key: "UART0", label: "UART0", line: LINE }], ...extra,
})

let db: TestDb | null = null
const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  await db?.cleanup()
  db = null
  for (const c of cleanups.splice(0)) await c()
})

function profile(files: Record<string, unknown>): string {
  const t = withTempDir("rm-perfil-")
  cleanups.push(t.cleanup)
  fs.mkdirSync(path.join(t.dir, "plantillas"))
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(t.dir, "plantillas", name), typeof body === "string" ? body : JSON.stringify(body))
  }
  return t.dir
}

describe("loadProfileTemplates", () => {
  it("reads only top-level .json files, sorted, and reports file + path errors", () => {
    const dir = profile({
      "b.json": tpl("equipo-b", "Equipo B"),
      "a.json": tpl("equipo-a", "Equipo A"),
      "_borrador.json": tpl("x", "X"),
      ".oculta.json": tpl("y", "Y"),
      "notas.txt": "hola",
      "mal.json": { ...tpl("equipo-c", "Equipo C"), consoles: [{ key: "uart0", label: "UART0", line: LINE }] },
      "roto.json": "{ no es json",
      "repetida.json": tpl("equipo-a", "Otra A"),
    })
    const r = loadProfileTemplates(dir)
    expect(r.found).toBe(true)
    expect(r.templates.map((t) => [t.file, t.key, t.order])).toEqual([["plantillas/a.json", "equipo-a", 0], ["plantillas/b.json", "equipo-b", 1]])
    const msgs = r.errors.flatMap((e) => e.messages)
    expect(msgs.some((m) => m.startsWith("plantillas/mal.json: consoles[0].key: Usa mayúsculas"))).toBe(true)
    expect(msgs.some((m) => m.startsWith("plantillas/roto.json: JSON no válido"))).toBe(true)
    expect(msgs).toContain("plantillas/repetida.json: key: la clave «equipo-a» ya la usa plantillas/a.json")
    expect(r.errors.find((e) => e.file === "plantillas/mal.json")?.key).toBe("equipo-c")
  })

  it("no profile, or no plantillas/ folder: nothing found", () => {
    expect(loadProfileTemplates(null)).toMatchObject({ dir: null, found: false, templates: [], errors: [] })
    const t = withTempDir("rm-perfil-")
    cleanups.push(t.cleanup)
    expect(loadProfileTemplates(t.dir)).toMatchObject({ found: false, templates: [] })
  })
})

describe("syncProfileTemplates", () => {
  it("creates, updates, leaves alone and retires; never deletes", async () => {
    db = await createTestDb()
    const dir = profile({ "a.json": tpl("equipo-a", "Equipo A", { needsReview: true }), "b.json": tpl("equipo-b", "Equipo B") })
    const r1 = await syncProfileTemplates(db.prisma, loadProfileTemplates(dir))
    expect(r1).toMatchObject({ created: ["Equipo A", "Equipo B"], updated: [], linked: [], retired: [], errors: [] })
    const a = await db.prisma.equipmentTemplate.findUniqueOrThrow({ where: { key: "equipo-a" } })
    expect(a).toMatchObject({ source: "file", sourceFile: "plantillas/a.json", needsReview: true, retiredAt: null, position: 0 })

    const r2 = await syncProfileTemplates(db.prisma, loadProfileTemplates(dir))
    expect(r2).toMatchObject({ created: [], updated: [], unchanged: 2 })

    // An equipment created from B keeps working after B's file goes away.
    const b = await db.prisma.equipmentTemplate.findUniqueOrThrow({ where: { key: "equipo-b" } })
    await db.prisma.equipment.create({ data: { name: "Equipo B #01", templateId: b.id, templateName: b.name } })
    fs.rmSync(path.join(dir, "plantillas", "b.json"))
    fs.writeFileSync(path.join(dir, "plantillas", "a.json"), JSON.stringify(tpl("equipo-a", "Equipo A", { relays: [{ key: "POWER", label: "Alimentación", purpose: "power" }] })))
    const r3 = await syncProfileTemplates(db.prisma, loadProfileTemplates(dir))
    expect(r3).toMatchObject({ updated: ["Equipo A"], retired: ["Equipo B"] })
    expect(TemplateSpecSchema.parse((await db.prisma.equipmentTemplate.findUniqueOrThrow({ where: { key: "equipo-a" } })).spec).relays).toHaveLength(1)
    const retired = await db.prisma.equipmentTemplate.findUniqueOrThrow({ where: { key: "equipo-b" } })
    expect(retired.retiredAt).not.toBeNull()
    expect(await db.prisma.equipment.findFirstOrThrow({ where: { name: "Equipo B #01" } })).toMatchObject({ templateId: b.id })

    // The file comes back: no longer retired.
    fs.writeFileSync(path.join(dir, "plantillas", "b.json"), JSON.stringify(tpl("equipo-b", "Equipo B")))
    const r4 = await syncProfileTemplates(db.prisma, loadProfileTemplates(dir))
    expect(r4.updated).toEqual(["Equipo B"])
    expect((await db.prisma.equipmentTemplate.findUniqueOrThrow({ where: { key: "equipo-b" } })).retiredAt).toBeNull()
  })

  it("an invalid file leaves its template as it was (not retired)", async () => {
    db = await createTestDb()
    const dir = profile({ "a.json": tpl("equipo-a", "Equipo A") })
    await syncProfileTemplates(db.prisma, loadProfileTemplates(dir))
    fs.writeFileSync(path.join(dir, "plantillas", "a.json"), JSON.stringify({ ...tpl("equipo-a", "Equipo A"), consoles: "no" }))
    const r = await syncProfileTemplates(db.prisma, loadProfileTemplates(dir))
    expect(r.retired).toEqual([])
    expect(r.errors[0]).toMatch(/^plantillas\/a\.json: consoles: /)
    expect((await db.prisma.equipmentTemplate.findUniqueOrThrow({ where: { key: "equipo-a" } })).retiredAt).toBeNull()
  })

  it("a name taken by a local template gets the key appended", async () => {
    db = await createTestDb()
    await db.prisma.equipmentTemplate.create({ data: { name: "Equipo A", spec: TemplateSpecSchema.parse({ version: 1, consoles: [], relays: [] }) } })
    const r = await syncProfileTemplates(db.prisma, loadProfileTemplates(profile({ "a.json": tpl("equipo-a", "Equipo A") })))
    expect(r.created).toEqual(["Equipo A (equipo-a)"])
    expect(r.warnings[0]).toMatch(/ya hay otra plantilla con ese nombre/)
  })

  it("without the plantillas/ folder nothing is retired", async () => {
    db = await createTestDb()
    const dir = profile({ "a.json": tpl("equipo-a", "Equipo A") })
    await syncProfileTemplates(db.prisma, loadProfileTemplates(dir))
    fs.rmSync(path.join(dir, "plantillas"), { recursive: true })
    const r = await syncProfileTemplates(db.prisma, loadProfileTemplates(dir))
    expect(r.retired).toEqual([])
    expect(r.warnings[0]).toMatch(/plantillas: las plantillas definidas en ficheros no cambian/)
  })
})

describe("upgrade of a 2.x database (predefined templates)", () => {
  it("keeps every row: a key with a file is linked to it, the rest stay local and editable", async () => {
    const t = withTempDir("rm-upgrade-")
    cleanups.push(t.cleanup)
    // The migrations of 2.4.0 (everything before 3.0.0's), then two predefined templates and one of the user's.
    const old = path.join(t.dir, "migrations")
    fs.mkdirSync(old)
    for (const m of fs.readdirSync(MIGRATIONS_DIR)) {
      if (m < "20261006000000") fs.cpSync(path.join(MIGRATIONS_DIR, m), path.join(old, m), { recursive: true })
    }
    const dbFile = path.join(t.dir, "relay-manager.db")
    await migrateDatabase({ dbFile, migrationsDir: old, backupDir: null, appVersion: "2.4.0", log: () => {} })
    const raw = new Database(dbFile)
    const spec = JSON.stringify({ version: 1, namePattern: "X #{nn}", skipInterfaces: [], consoles: [{ key: "UART0", label: "Mía", line: LINE, enterMode: "cr", localEcho: false, identify: {} }], relays: [] })
    const ins = raw.prepare(`INSERT INTO EquipmentTemplate (id, key, name, description, builtin, needsReview, spec, position, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`)
    ins.run("t1", "equipo-a", "Equipo A", "editada por el usuario", 1, 0, spec, 0)
    ins.run("t2", "equipo-c", "Equipo C", null, 1, 1, spec, 1)
    ins.run("t3", null, "Mía", null, 0, 0, spec, 2)
    raw.prepare(`INSERT INTO Equipment (id, name, position, templateId, templateName, updatedAt) VALUES ('e1', 'Equipo C #01', 0, 't2', 'Equipo C', CURRENT_TIMESTAMP)`).run()
    raw.close()

    const r = await migrateDatabase({ dbFile, migrationsDir: MIGRATIONS_DIR, backupDir: null, appVersion: "3.0.0", log: () => {} })
    expect(r.applied).toEqual(["20261006000000_perfil"])
    const prisma = createPrismaClient(dbFile)
    cleanups.push(() => prisma.$disconnect())
    const rows = await prisma.equipmentTemplate.findMany({ orderBy: { position: "asc" } })
    expect(rows.map((x) => [x.id, x.key, x.source, x.retiredAt])).toEqual([["t1", "equipo-a", "local", null], ["t2", "equipo-c", "local", null], ["t3", null, "local", null]])

    // The profile has a file for equipo-a only.
    const rep = await syncProfileTemplates(prisma, loadProfileTemplates(profile({ "a.json": tpl("equipo-a", "Equipo A", { needsReview: true }) })))
    expect(rep).toMatchObject({ linked: ["Equipo A"], created: [], retired: [] })
    const after = await prisma.equipmentTemplate.findMany({ orderBy: { position: "asc" } })
    expect(after.map((x) => [x.id, x.source, x.sourceFile, x.needsReview])).toEqual([
      ["t1", "file", "plantillas/a.json", true], ["t2", "local", null, true], ["t3", "local", null, false],
    ])
    expect(await prisma.equipment.findUniqueOrThrow({ where: { id: "e1" } })).toMatchObject({ templateId: "t2" })
  })
})
