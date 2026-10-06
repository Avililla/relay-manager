import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { DEFAULT_LINE } from "@/lib/contracts/enums"
import { TemplateSpecSchema, type TemplateSpec } from "@/lib/contracts/templates"
import fs from "node:fs"
import path from "node:path"
import { seedDefaults } from "@/server/db/seed"
import type { AuthUser } from "@/server/runtime/types"
import { createTestDb, makeUser, withTempDir, type TestDb } from "../../../test/helpers"
import {
  applyPropagation, createTemplate, deleteTemplate, duplicateTemplate, instantiateTemplate, previewPropagation,
  reloadTemplates, updateTemplate,
} from "./templates"
import { ctxFor, fakeDomain, pathBinding, resetDomainTables, toAuthUser, type FakeDomain } from "./test-fixtures"

let db: TestDb
let fx: FakeDomain
let admin: AuthUser

beforeAll(async () => { db = await createTestDb() })
afterAll(async () => { await db.cleanup() })
beforeEach(async () => {
  await resetDomainTables(db.prisma)
  await seedDefaults(db.prisma)
  fx = fakeDomain(db.prisma)
  admin = toAuthUser(await makeUser(db.prisma, { isAdmin: true }))
})

const spec = (keys: string[]): TemplateSpec => TemplateSpecSchema.parse({
  version: 1, consoles: keys.map((k) => ({ key: k, label: k, line: { ...DEFAULT_LINE } })), relays: [],
})
const byKey = (key: string) => db.prisma.equipmentTemplate.findUniqueOrThrow({ where: { key } })
/** A file template as the profile sync leaves it. */
const fileTemplate = (key: string, name: string, extra: { retiredAt?: Date | null; needsReview?: boolean } = {}) => db.prisma.equipmentTemplate.create({
  data: { key, name, source: "file", sourceFile: `plantillas/${key}.json`, needsReview: extra.needsReview ?? false, retiredAt: extra.retiredAt ?? null, spec: spec(["UART0", "UART1"]) },
})

describe("templates service (§4.15)", () => {
  it("create/update/delete a custom template; names are unique", async () => {
    const { id } = await createTemplate({ name: "Mi placa", description: null, spec: spec(["UART0"]) }, ctxFor(fx.deps, admin))
    const row = await db.prisma.equipmentTemplate.findUniqueOrThrow({ where: { id } })
    expect([row.source, row.key, row.needsReview]).toEqual(["local", null, false])
    await expect(createTemplate({ name: "mi placa", description: null, spec: spec([]) }, ctxFor(fx.deps, admin)))
      .rejects.toMatchObject({ code: "CONFLICT", fieldErrors: { name: [expect.any(String)] } })
    await updateTemplate({ templateId: id, name: "Mi placa 2", description: "x", spec: spec(["UART0", "UART1"]), markReviewed: false }, ctxFor(fx.deps, admin))
    expect(TemplateSpecSchema.parse((await db.prisma.equipmentTemplate.findUniqueOrThrow({ where: { id } })).spec).consoles).toHaveLength(2)
    await deleteTemplate({ templateId: id }, ctxFor(fx.deps, admin))
    expect(await db.prisma.equipmentTemplate.count({ where: { id } })).toBe(0)
    expect(fx.audit.inputs.map((i) => i.action)).toEqual(["template.create", "template.update", "template.delete"])
    expect(fx.audit.inputs[1].detail).toMatchObject({ source: "editor" })
  })

  it("markReviewed clears needsReview on a local template; editing without it keeps the flag", async () => {
    const t = await db.prisma.equipmentTemplate.create({ data: { key: "equipo-a", name: "Equipo A", needsReview: true, spec: spec(["UART0"]) } })
    await updateTemplate({ templateId: t.id, name: t.name, description: t.description, spec: spec(["UART0"]), markReviewed: false }, ctxFor(fx.deps, admin))
    expect((await byKey("equipo-a")).needsReview).toBe(true)
    await updateTemplate({ templateId: t.id, name: t.name, description: t.description, spec: spec(["UART0"]), markReviewed: true }, ctxFor(fx.deps, admin))
    expect((await byKey("equipo-a")).needsReview).toBe(false)
  })

  it("file templates are read-only: no update, no delete until retired", async () => {
    const t = await fileTemplate("equipo-c", "Equipo C")
    await expect(updateTemplate({ templateId: t.id, name: "Equipo C", description: null, spec: spec(["A"]), markReviewed: false }, ctxFor(fx.deps, admin)))
      .rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringMatching(/plantillas\/equipo-c\.json/) })
    await expect(deleteTemplate({ templateId: t.id }, ctxFor(fx.deps, admin))).rejects.toMatchObject({ code: "FORBIDDEN" })
    const gone = await fileTemplate("equipo-d", "Equipo D", { retiredAt: new Date() })
    await deleteTemplate({ templateId: gone.id }, ctxFor(fx.deps, admin))
    expect(await db.prisma.equipmentTemplate.count({ where: { id: gone.id } })).toBe(0)
  })

  it("duplicate copies the spec into an editable local template", async () => {
    const t = await fileTemplate("equipo-b", "Equipo B", { needsReview: true })
    const { id } = await duplicateTemplate({ templateId: t.id, name: "Equipo B v2" }, ctxFor(fx.deps, admin))
    const copy = await db.prisma.equipmentTemplate.findUniqueOrThrow({ where: { id } })
    expect([copy.source, copy.sourceFile, copy.key, copy.name, copy.needsReview]).toEqual(["local", null, null, "Equipo B v2", true])
    expect(copy.spec).toEqual(t.spec)
    await updateTemplate({ templateId: id, name: "Equipo B v2", description: null, spec: spec(["X"]), markReviewed: true }, ctxFor(fx.deps, admin))
    await expect(duplicateTemplate({ templateId: t.id, name: "Equipo B" }, ctxFor(fx.deps, admin))).rejects.toMatchObject({ code: "CONFLICT" })
  })

  it("«Recargar plantillas» copies the profile's files and audits the changes", async () => {
    const tmp = withTempDir("rm-perfil-")
    try {
      fs.mkdirSync(path.join(tmp.dir, "plantillas"))
      fs.writeFileSync(path.join(tmp.dir, "plantillas", "a.json"), JSON.stringify({ key: "equipo-a", name: "Equipo A", consoles: [{ key: "UART0", label: "UART0", line: DEFAULT_LINE }] }))
      fs.writeFileSync(path.join(tmp.dir, "plantillas", "mala.json"), "{")
      const profile = { dir: tmp.dir, path: tmp.dir, explicit: true, envFile: null, warnings: [] }
      const r = await reloadTemplates(ctxFor(fx.deps, admin), { profile })
      expect(r).toMatchObject({ dir: tmp.dir, created: ["Equipo A"], errors: [expect.stringMatching(/^plantillas\/mala\.json: JSON no válido/)] })
      expect((await byKey("equipo-a")).source).toBe("file")
      expect(fx.audit.inputs.at(-1)).toMatchObject({ action: "template.reload", detail: { created: ["Equipo A"] } })
      const again = await reloadTemplates(ctxFor(fx.deps, admin), { profile })
      expect(again).toMatchObject({ created: [], unchanged: 1 })
    } finally {
      tmp.cleanup()
    }
  })

  it("instantiate is pure and returns an independent draft", () => {
    const s = spec(["UART0", "UART1"])
    const draft = instantiateTemplate(s)
    expect(draft.consoles.map((c) => c.key)).toEqual(["UART0", "UART1"])
    expect(draft.relays).toEqual([])
    draft.consoles[0].label = "cambiado"
    expect(s.consoles[0].label).toBe("UART0")
  })

  it("propagation (P2): previews and applies label/line changes and new unbound consoles; never deletes or touches relays", async () => {
    const { id: tplId } = await createTemplate({ name: "T", description: null, spec: spec(["A", "B"]) }, ctxFor(fx.deps, admin))
    const eq = await db.prisma.equipment.create({
      data: {
        name: "EQ", templateId: tplId, templateName: "T",
        consoles: { create: [
          { key: "A", label: "A", position: 0, ...pathBinding("/dev/ttyUSB0") },
          { key: "Z", label: "Z", position: 1 },
        ] },
      },
    })
    const next = TemplateSpecSchema.parse({
      version: 1, consoles: [
        { key: "A", label: "A nueva", line: { ...DEFAULT_LINE, baudRate: 9600 } },
        { key: "B", label: "B", line: { ...DEFAULT_LINE } },
      ], relays: [],
    })
    await updateTemplate({ templateId: tplId, name: "T", description: null, spec: next, markReviewed: false }, ctxFor(fx.deps, admin))
    const preview = await previewPropagation({ templateId: tplId, equipmentIds: [eq.id] }, ctxFor(fx.deps, admin))
    expect(preview.items).toHaveLength(1)
    expect(preview.items[0].changes.length).toBeGreaterThanOrEqual(2)
    const r = await applyPropagation({ templateId: tplId, equipmentIds: [eq.id] }, ctxFor(fx.deps, admin))
    expect(r).toEqual({ updated: 1 })
    const cs = await db.prisma.serialConsole.findMany({ where: { equipmentId: eq.id }, orderBy: { position: "asc" } })
    expect(cs.map((c) => [c.key, c.label, c.baudRate, c.bindingKey])).toEqual([
      ["A", "A nueva", 9600, "virtual:/dev/ttyUSB0"], ["Z", "Z", 115200, null], ["B", "B", 115200, null],
    ])
    expect(fx.reloadedEquipment).toEqual([eq.id])
    expect(fx.audit.inputs.at(-1)).toMatchObject({ action: "template.propagate" })
  })
})
