import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import type { BackupDTO } from "@/lib/contracts/system"
import { setRuntime } from "@/server/runtime/registry"
import type { AuthUser, Runtime } from "@/server/runtime/types"
import { exportConfig } from "@/server/services/config-io"
import { createTestDb, fakeAudit, fakeBus, fakeRuntime, type TestDb } from "../../test/helpers"
import { createBackup, deleteBackup, importConfig, runHealthChecks } from "./system"

const state = vi.hoisted(() => ({ user: null as AuthUser | null }))
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-forwarded-for": "10.0.0.8" }) }))
vi.mock("next/cache", () => ({ revalidatePath: () => {} }))
vi.mock("@/server/authz", () => ({ getAuthUser: async () => state.user }))

const admin: AuthUser = { id: "adm", username: "jefa", name: "Jefa", isAdmin: true, roleIds: [], mustChangePassword: false, sessionVersion: 1 }
let db: TestDb
let rt: Runtime
let audit: ReturnType<typeof fakeAudit>
let bus: ReturnType<typeof fakeBus>
let reloaded: string[]
let backupCalls: Array<[string, string]>

beforeAll(async () => { db = await createTestDb() })
afterAll(async () => { await db.cleanup() })
beforeEach(async () => {
  state.user = admin
  audit = fakeAudit()
  bus = fakeBus()
  reloaded = []
  backupCalls = []
  rt = fakeRuntime({ prisma: db.prisma, audit, bus })
  rt.serial.consoles.reloadEquipment = async (id) => { reloaded.push(id) }
  const dto: BackupDTO = { name: "relay-manager-20260923T101500Z-manual.db", label: "manual", createdAt: "2026-09-23T10:15:00.000Z", sizeBytes: 4096, appVersion: "2.0.0" }
  rt.ops.backups.create = async (label) => { backupCalls.push(["create", label]); return dto }
  rt.ops.backups.remove = async (name) => { backupCalls.push(["remove", name]) }
  rt.ops.health.run = async () => [{ id: "runtime.node", group: "runtime", level: "ok", label: "Node", message: "22.23.2", hint: null }]
  setRuntime(rt)
  await db.prisma.equipment.deleteMany({})
})

describe("system actions (§7.2)", () => {
  it("createBackup uses the label manual; deleteBackup validates the name", async () => {
    expect(await createBackup({})).toMatchObject({ ok: true, data: { label: "manual" } })
    expect(await deleteBackup({ name: "../../etc/passwd" })).toMatchObject({ ok: false, error: { code: "VALIDATION" } })
    expect(await deleteBackup({ name: "relay-manager-20260923T101500Z-manual.db" })).toEqual({ ok: true, data: null })
    expect(backupCalls).toEqual([["create", "manual"], ["remove", "relay-manager-20260923T101500Z-manual.db"]])
  })

  it("importConfig: dry run changes nothing; a real import reloads, publishes and audits config.import", async () => {
    const src = await createTestDb()
    try {
      await src.prisma.settings.upsert({ where: { id: "global" }, create: {}, update: {} })
      await src.prisma.equipment.create({ data: { name: "Importado", consoles: { create: [{ key: "CONSOLA", label: "Consola", position: 0 }] } } })
      const json = JSON.stringify(await exportConfig(src.prisma, { appVersion: "2.0.0" }))
      const dry = await importConfig({ json, dryRun: true })
      expect(dry).toMatchObject({ ok: true, data: { dryRun: true, created: { equipment: 1 } } })
      expect(await db.prisma.equipment.count()).toBe(0)
      expect(audit.inputs).toEqual([])
      const real = await importConfig({ json, dryRun: false })
      expect(real).toMatchObject({ ok: true, data: { dryRun: false, created: { equipment: 1 } } })
      const eq = await db.prisma.equipment.findUniqueOrThrow({ where: { name: "Importado" } })
      expect(reloaded).toEqual([eq.id])
      expect(bus.events.map((e) => e.event)).toContainEqual({ type: "equipment.changed", equipmentId: eq.id, change: "created" })
      expect(audit.inputs.map((i) => [i.action, i.actor.ip])).toEqual([["config.import", "10.0.0.8"]])
      expect(await importConfig({ json: "{no", dryRun: true })).toMatchObject({ ok: false, error: { code: "VALIDATION" } })
    } finally {
      await src.cleanup()
    }
  })

  it("runHealthChecks returns the ops health; non-admins are refused", async () => {
    expect(await runHealthChecks({})).toMatchObject({ ok: true, data: [{ id: "runtime.node" }] })
    state.user = { ...admin, isAdmin: false }
    expect(await runHealthChecks({})).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } })
  })
})
