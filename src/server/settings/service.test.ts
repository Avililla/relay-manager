import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createSettingsService } from "./service"
import { seedDefaults } from "@/server/db/seed"
import { DomainError } from "@/server/errors"
import type { SettingsService } from "@/server/runtime/types"
import { createTestDb, fakeAudit, fakeBus, type TestDb } from "../../../test/helpers"

let db: TestDb
let svc: SettingsService
const bus = fakeBus()
const audit = fakeAudit()
beforeAll(async () => {
  db = await createTestDb()
  await seedDefaults(db.prisma)
  svc = await createSettingsService({ prisma: db.prisma, bus, audit })
})
afterAll(async () => { await db.cleanup() })

describe("settings service", () => {
  it("get() is a synchronous read of the cached row", () => {
    const s = svc.get()
    expect(s).toMatchObject({ labName: "Relay Manager", bannerText: null, reservationTimeoutMin: 30, reservationWarningMin: 5, inputCapture: "markers", setupCompletedAt: null })
    expect(s.updatedAt).toMatch(/Z$/)
  })
  it("update validates, writes, refreshes, publishes settings.changed and audits the diff", async () => {
    const actor = { kind: "user" as const, id: "u1", name: "ana", ip: "10.0.0.1" }
    const s = await svc.update({ labName: "Banco 2", captureRetentionDays: 10 }, actor)
    expect(s.labName).toBe("Banco 2")
    expect(svc.get().labName).toBe("Banco 2")
    expect((await db.prisma.settings.findUniqueOrThrow({ where: { id: "global" } })).updatedById).toBe("u1")
    expect(bus.events.at(-1)).toEqual({ event: { type: "settings.changed", labName: "Banco 2", bannerText: null, reservationWarningMin: 5 }, audience: { kind: "all" } })
    expect(audit.inputs.at(-1)).toMatchObject({ action: "settings.update", detail: { changed: { labName: ["Relay Manager", "Banco 2"], captureRetentionDays: [30, 10] } } })
  })
  it("does not publish when only non-public fields change", async () => {
    const n = bus.events.length
    await svc.update({ backupDailyHour: 4 }, { kind: "cli", id: null, name: "cli" })
    expect(bus.events.length).toBe(n)
  })
  it("rejects warning >= timeout after merging and invalid input", async () => {
    await expect(svc.update({ reservationWarningMin: 30 }, { kind: "cli", id: null, name: "cli" })).rejects.toMatchObject({ code: "VALIDATION" })
    await expect(svc.update({ labName: "" }, { kind: "cli", id: null, name: "cli" })).rejects.toBeInstanceOf(DomainError)
  })
  it("reload re-reads the row", async () => {
    await db.prisma.settings.update({ where: { id: "global" }, data: { bannerText: "USO INTERNO" } })
    expect(svc.get().bannerText).toBeNull()
    await svc.reload()
    expect(svc.get().bannerText).toBe("USO INTERNO")
  })
})
