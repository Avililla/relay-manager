import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { setRuntime } from "@/server/runtime/registry"
import type { Runtime } from "@/server/runtime/types"
import { createTestDb, fakeRuntime, type TestDb } from "../../../test/helpers"
import { getPublicSettings } from "./settings"
import pkg from "../../../package.json"

let db: TestDb
let rt: Runtime

beforeAll(async () => { db = await createTestDb() })
afterAll(async () => { await db.cleanup() })
beforeEach(async () => {
  rt = fakeRuntime({ prisma: db.prisma })
  setRuntime(rt)
})

describe("getPublicSettings (§2.2 rule 6)", () => {
  it("works without a runtime (defaults) and with one", async () => {
    const key = Symbol.for("relay-manager.runtime")
    const g = globalThis as typeof globalThis & { [key]?: Runtime }
    const saved = g[key]
    g[key] = undefined
    try {
      expect(await getPublicSettings()).toEqual({ labName: "Relay Manager", bannerText: null, version: pkg.version, rev: "dev" })
    } finally {
      g[key] = saved
    }
    await rt.settings.update({ labName: "Laboratorio norte", bannerText: "USO INTERNO" }, { kind: "system", id: null, name: "sistema" })
    expect(await getPublicSettings()).toEqual({ labName: "Laboratorio norte", bannerText: "USO INTERNO", version: pkg.version, rev: "dev" })
  })
})
