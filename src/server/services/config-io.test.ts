import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { ConfigExportV1Schema, type ConfigExportV1 } from "@/lib/contracts/config-io"
import { DEFAULT_LINE } from "@/lib/contracts/enums"
import { seedDefaults } from "@/server/db/seed"
import type { ActorRef } from "@/server/runtime/types"
import { createTestDb, type TestDb } from "../../../test/helpers"
import { exportConfig, importConfig, importConfigDetailed } from "./config-io"
import { pathBinding, resetDomainTables, usbBinding } from "./test-fixtures"

const actor: ActorRef = { kind: "cli", id: null, name: "cli" }
let src: TestDb
let dst: TestDb

beforeAll(async () => { src = await createTestDb(); dst = await createTestDb() })
afterAll(async () => { await src.cleanup(); await dst.cleanup() })
beforeEach(async () => {
  for (const d of [src, dst]) {
    await resetDomainTables(d.prisma)
    await d.prisma.settings.upsert({ where: { id: "global" }, create: {}, update: { labName: "Laboratorio", bannerText: null } })
    await seedDefaults(d.prisma)
    // Both servers have the same profile: one template defined in a file.
    await d.prisma.equipmentTemplate.create({
      data: {
        key: "equipo-a", name: "Equipo A", source: "file", sourceFile: "plantillas/equipo-a.json", needsReview: true,
        spec: { version: 1, namePattern: "Equipo A #{nn}", skipInterfaces: [], consoles: [{ key: "UART0", label: "UART0", line: DEFAULT_LINE, enterMode: "cr", localEcho: false, identify: {} }], relays: [], accesses: [] },
      },
    })
  }
})

async function seedSource(): Promise<void> {
  const p = src.prisma
  await p.settings.update({ where: { id: "global" }, data: { labName: "Laboratorio norte", bannerText: "USO INTERNO" } })
  const role = await p.role.create({ data: { name: "Integración", description: "Banco 1" } })
  const tpl = await p.equipmentTemplate.create({
    data: { name: "Placa X", spec: { version: 1, namePattern: "X #{nn}", skipInterfaces: [0], consoles: [{ key: "UART0", label: "UART0", line: DEFAULT_LINE, enterMode: "cr", localEcho: false, identify: {} }], relays: [] } },
  })
  const board = await p.relayBoard.create({
    data: { name: "dS378", driver: "devantech-ds-ascii", host: "127.0.0.2", httpPort: 80, tcpPort: 17123, model: "dS378", relayCount: 8, options: { useHttpFallback: true }, password: "secreta" },
  })
  const eq1 = await p.equipment.create({
    include: { consoles: true },
    data: {
      name: "Equipo A #01", serialNumber: "EA-0001", description: "Unidad 1", templateId: tpl.id, templateName: "Placa X",
      roles: { connect: [{ id: role.id }] },
      consoles: { create: [
        { key: "UART0", label: "UART0", position: 0, baudRate: 115200, identifyHostnameRegex: "uart0", ...pathBinding("/run/relay-manager/sim/ttyV0") },
        { key: "UART1", label: "UART1", position: 1, hupcl: true, captureToDisk: false, ...usbBinding("usb:0403:6011:FT4ABCDE:if1:p0", 1) },
        { key: "AUX", label: "Aux", position: 2, baudRate: 9600, parity: "even", dataBits: 7, stopBits: 2, enterMode: "crlf", localEcho: true },
      ] },
      relays: { create: [{ boardId: board.id, channel: 1, position: 0, key: "POWER", label: "Alimentación", purpose: "power", requireConfirm: true }] },
    },
  })
  await p.equipment.create({ data: { name: "Vacío" } })
  const uart1 = eq1.consoles.find((c) => c.key === "UART1")
  await p.equipmentAccess.createMany({ data: [
    { equipmentId: eq1.id, position: 0, key: "JTAG0", label: "JTAG 0", kind: "jtag", port: 3201, jtagCableSerial: "210299ABCDEF" },
    { equipmentId: eq1.id, position: 1, key: "SERIE1", label: "Serie 1", kind: "serial", port: 3202, consoleId: uart1?.id, policy: "always" },
    { equipmentId: eq1.id, position: 2, key: "ETH", label: "Ethernet", kind: "tcp", port: 3203, targetHost: "192.168.1.10", targetPort: 22, enabled: false },
  ] })
  await p.cableLabel.create({ data: { kind: "jtag", identity: "210299ABCDEF", name: "JTAG-07", notes: "Banco 2" } })
}

// Board passwords never travel, so hasPassword cannot survive a round trip.
const strip = (c: ConfigExportV1) => ({ ...c, exportedAt: "x", boards: c.boards.map((b) => ({ ...b, hasPassword: false })) })

describe("config import/export (§4.15)", () => {
  it("exports without users or board passwords, and the export validates", async () => {
    await seedSource()
    const cfg = await exportConfig(src.prisma, { appVersion: "2.0.0" })
    expect(ConfigExportV1Schema.safeParse(cfg).success).toBe(true)
    expect(cfg.settings).toEqual({ labName: "Laboratorio norte", bannerText: "USO INTERNO" })
    expect(cfg.boards[0]).toMatchObject({ name: "dS378", hasPassword: true })
    const raw = JSON.stringify(cfg)
    expect(raw).not.toContain("secreta")
    expect(raw).not.toContain("passwordHash")
    expect(cfg.templates.map((t) => [t.name, t.source, t.sourceFile]).sort()).toEqual([["Equipo A", "file", "plantillas/equipo-a.json"], ["Placa X", "local", null]])
    expect(cfg.equipment.find((e) => e.name === "Equipo A #01")?.consoles.map((c) => c.binding?.matchBy ?? null)).toEqual(["path", "adapter", null])
  })

  it("export → import round trip into an empty DB (dry run first changes nothing)", async () => {
    await seedSource()
    const cfg = await exportConfig(src.prisma, { appVersion: "2.0.0" })
    const json = JSON.stringify(cfg)
    const dry = await importConfig(dst.prisma, json, { dryRun: true }, actor)
    expect(dry.dryRun).toBe(true)
    expect(dry.created).toEqual({ roles: 1, templates: 1, boards: 1, equipment: 2 })
    expect(dry.skipped.map((s) => [s.kind, s.name]).sort()).toEqual([["template", "Equipo A"]])
    expect(await dst.prisma.equipment.count()).toBe(0)
    expect((await dst.prisma.settings.findUniqueOrThrow({ where: { id: "global" } })).labName).toBe("Laboratorio")

    const detailed = await importConfigDetailed(dst.prisma, json, { dryRun: false }, actor)
    expect(detailed.report.created).toEqual(dry.created)
    expect(detailed.createdEquipmentIds).toHaveLength(2)
    expect(detailed.report.warnings.some((w) => w.includes("dS378") && w.includes("contraseña"))).toBe(true)
    const back = await exportConfig(dst.prisma, { appVersion: "2.0.0" })
    expect(strip(back)).toEqual(strip(cfg))
  })

  it("a second import skips every duplicate by name", async () => {
    await seedSource()
    const json = JSON.stringify(await exportConfig(src.prisma, { appVersion: "2.0.0" }))
    await importConfig(dst.prisma, json, { dryRun: false }, actor)
    const again = await importConfig(dst.prisma, json, { dryRun: false }, actor)
    expect(again.created).toEqual({ roles: 0, templates: 0, boards: 0, equipment: 0 })
    expect(again.skipped.filter((s) => s.kind === "equipment").map((s) => s.name).sort()).toEqual(["Equipo A #01", "Vacío"])
    expect(again.skipped.filter((s) => s.kind === "board")).toHaveLength(1)
    expect(again.skipped.filter((s) => s.kind === "role")).toHaveLength(1)
  })

  it("rejects binding paths outside /dev/ or the allowed globs, invalid JSON and other formats", async () => {
    await seedSource()
    const cfg = await exportConfig(src.prisma, { appVersion: "2.0.0" })
    const bad = structuredClone(cfg)
    const b = bad.equipment[0].consoles[0].binding
    if (!b) throw new Error("fixture")
    b.devicePath = "/etc/shadow"
    await expect(importConfig(dst.prisma, JSON.stringify(bad), { dryRun: true }, actor)).rejects.toMatchObject({
      code: "VALIDATION", fieldErrors: { "equipment.0.consoles.0.binding.devicePath": [expect.any(String)] },
    })
    b.devicePath = "/home/x/../../etc/shadow"
    await expect(importConfig(dst.prisma, JSON.stringify(bad), { dryRun: true }, actor)).rejects.toMatchObject({ code: "VALIDATION" })
    b.devicePath = "/dev/../etc/shadow"
    await expect(importConfig(dst.prisma, JSON.stringify(bad), { dryRun: true }, actor)).rejects.toMatchObject({
      code: "VALIDATION", fieldErrors: { "equipment.0.consoles.0.binding.devicePath": [expect.any(String)] },
    })
    await expect(importConfig(dst.prisma, "{nope", { dryRun: true }, actor)).rejects.toMatchObject({ code: "VALIDATION" })
    await expect(importConfig(dst.prisma, JSON.stringify({ format: "otro" }), { dryRun: true }, actor)).rejects.toMatchObject({ code: "VALIDATION" })
    expect(await dst.prisma.equipment.count()).toBe(0)
  })

  it("imports old files (builtin) and file templates as local, editable templates", async () => {
    const cfg = await exportConfig(src.prisma, { appVersion: "2.0.0" })
    const spec = cfg.templates[0]?.spec
    if (!spec) throw new Error("fixture")
    const forged: ConfigExportV1 = {
      ...cfg, roles: [], boards: [], equipment: [],
      templates: [
        { key: "falsa", name: "Falsa predefinida", description: null, builtin: true, needsReview: false, spec },
        { key: null, name: "Sin clave", description: null, builtin: true, needsReview: false, spec },
        { key: "equipo-z", name: "Equipo Z", description: null, source: "file", sourceFile: "plantillas/z.json", needsReview: false, spec },
      ],
    }
    const r = await importConfig(dst.prisma, JSON.stringify(forged), { dryRun: false }, actor)
    expect(r.created.templates).toBe(3)
    const rows = await dst.prisma.equipmentTemplate.findMany({ where: { name: { in: ["Falsa predefinida", "Sin clave", "Equipo Z"] } } })
    expect(rows.map((t) => [t.name, t.source, t.sourceFile]).sort()).toEqual([["Equipo Z", "local", null], ["Falsa predefinida", "local", null], ["Sin clave", "local", null]])
  })

  it("missing boards and roles become warnings, a taken binding is imported unbound", async () => {
    await seedSource()
    const cfg = await exportConfig(src.prisma, { appVersion: "2.0.0" })
    const partial: ConfigExportV1 = { ...cfg, boards: [], roles: [] }
    // A console on the destination already holds the UART1 binding.
    await dst.prisma.equipment.create({ data: { name: "Existente", consoles: { create: [{ key: "X", label: "X", position: 0, ...usbBinding("usb:0403:6011:FT4ABCDE:if1:p0", 1) }] } } })
    const r = await importConfigDetailed(dst.prisma, JSON.stringify(partial), { dryRun: false }, actor)
    expect(r.report.created.equipment).toBe(2)
    expect(r.report.warnings.join("\n")).toMatch(/Integración/)
    expect(r.report.warnings.join("\n")).toMatch(/dS378/)
    expect(r.report.warnings.join("\n")).toMatch(/UART1/)
    const eq = await dst.prisma.equipment.findUniqueOrThrow({ where: { name: "Equipo A #01" }, include: { consoles: { orderBy: { position: "asc" } }, relays: true } })
    expect(eq.relays).toEqual([])
    expect(eq.consoles.map((c) => c.bindingKey)).toEqual(["virtual:/run/relay-manager/sim/ttyV0", null, null])
  })

  it("carries accesses and cable labels; an access whose port is taken is skipped with a warning", async () => {
    await seedSource()
    const cfg = await exportConfig(src.prisma, { appVersion: "2.0.0" })
    const e = cfg.equipment.find((x) => x.name === "Equipo A #01")
    expect(e?.accesses.map((a) => [a.key, a.kind, a.port, a.consoleKey, a.cableSerial, a.policy, a.enabled])).toEqual([
      ["JTAG0", "jtag", 3201, null, "210299ABCDEF", "reserved", true],
      ["SERIE1", "serial", 3202, "UART1", null, "always", true],
      ["ETH", "tcp", 3203, null, null, "reserved", false],
    ])
    expect(cfg.cableLabels).toEqual([{ kind: "jtag", identity: "210299ABCDEF", name: "JTAG-07", notes: "Banco 2" }])
    const other = await dst.prisma.equipment.create({ data: { name: "Otro" } })
    await dst.prisma.equipmentAccess.create({ data: { equipmentId: other.id, position: 0, key: "X", label: "X", kind: "tcp", port: 3203 } })
    const r = await importConfig(dst.prisma, cfg, { dryRun: false }, actor)
    expect(r.warnings.some((w) => w.includes("ETH") && w.includes("3203"))).toBe(true)
    const acc = await dst.prisma.equipmentAccess.findMany({ where: { equipment: { name: "Equipo A #01" } }, orderBy: { position: "asc" }, include: { console: true } })
    expect(acc.map((a) => [a.key, a.port, a.console?.key ?? null, a.jtagCableSerial])).toEqual([["JTAG0", 3201, null, "210299ABCDEF"], ["SERIE1", 3202, "UART1", null]])
    expect(await dst.prisma.cableLabel.count()).toBe(1)
    // A 2.0.0 file (no accesses, no labels) still imports.
    const old = JSON.parse(JSON.stringify(cfg)) as Record<string, unknown>
    delete old.cableLabels
    const equipment = (old.equipment as Array<Record<string, unknown>>).map((e) => {
      const copy = { ...e }
      delete copy.accesses
      return copy
    })
    expect(ConfigExportV1Schema.safeParse({ ...old, equipment }).success).toBe(true)
  })

  it("an imported access outside RM_ACCESS_PORTS (or on the web port) is skipped with a warning; a JTAG label that is not a plain serial is not imported", async () => {
    await seedSource()
    const cfg = await exportConfig(src.prisma, { appVersion: "2.0.0" })
    const e = cfg.equipment.find((x) => x.name === "Equipo A #01")
    if (!e) throw new Error("missing")
    e.accesses[0].port = 22
    e.accesses[1].port = 3200
    cfg.cableLabels.push({ kind: "jtag", identity: "210299ABCDEF; exit", name: "JTAG-99", notes: null })
    const r = await importConfig(dst.prisma, cfg, { dryRun: false, accessPorts: { range: { from: 3201, to: 3230 }, httpPort: 3200 } }, actor)
    expect(r.warnings.filter((w) => w.includes("JTAG0") && w.includes("22"))).toHaveLength(1)
    expect(r.warnings.filter((w) => w.includes("SERIE1") && w.includes("3200"))).toHaveLength(1)
    expect(r.warnings.some((w) => w.includes("JTAG-99"))).toBe(true)
    const acc = await dst.prisma.equipmentAccess.findMany({ where: { equipment: { name: "Equipo A #01" } } })
    expect(acc.map((a) => a.port)).toEqual([3203])
    expect(await dst.prisma.cableLabel.findMany({ select: { name: true } })).toEqual([{ name: "JTAG-07" }])
  })
})
