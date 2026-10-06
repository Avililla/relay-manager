import { afterEach, describe, expect, it } from "vitest"
import { seedDefaults } from "./seed"
import { createTestDb, type TestDb } from "../../../test/helpers"

let db: TestDb
afterEach(async () => { await db?.cleanup() })

describe("seedDefaults", () => {
  it("creates the settings row once, with the generic lab name, and no templates", async () => {
    db = await createTestDb()
    expect(await seedDefaults(db.prisma)).toEqual({ settingsCreated: true })
    expect(await seedDefaults(db.prisma)).toEqual({ settingsCreated: false })
    expect(await db.prisma.settings.count()).toBe(1)
    const s = await db.prisma.settings.findUniqueOrThrow({ where: { id: "global" } })
    expect(s.labName).toBe("Relay Manager")
    expect(s.setupCompletedAt).toBeNull()
    expect(await db.prisma.equipmentTemplate.count()).toBe(0)
  })

  it("a new settings row takes the profile's lab name (RM_LAB_NAME); an existing one keeps its own", async () => {
    db = await createTestDb()
    await seedDefaults(db.prisma, { labName: "Laboratorio" })
    expect((await db.prisma.settings.findUniqueOrThrow({ where: { id: "global" } })).labName).toBe("Laboratorio")
    await seedDefaults(db.prisma, { labName: "Otro" })
    expect((await db.prisma.settings.findUniqueOrThrow({ where: { id: "global" } })).labName).toBe("Laboratorio")
  })
})
