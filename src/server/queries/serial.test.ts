import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import type { HealthCheckDTO } from "@/lib/contracts/system"
import { isDomainError } from "@/server/errors"
import { setRuntime } from "@/server/runtime/registry"
import type { AuthUser, Runtime } from "@/server/runtime/types"
import { createTestDb, fakeRuntime, testConfig, type TestDb } from "../../../test/helpers"
import { getConsoleCaptureFiles, getSerialPageData } from "./serial"

const user = (over: Partial<AuthUser> = {}): AuthUser => ({
  id: "u1", username: "ana", name: "Ana", isAdmin: false, roleIds: [], mustChangePassword: false, sessionVersion: 1, ...over,
})
const check = (id: string): HealthCheckDTO => ({ id, group: "serial", level: "warn", label: id, message: "m", hint: null })

let db: TestDb
let consoleId: string
let hiddenId: string
let rt: Runtime
let onlyAsked: readonly string[] | undefined
beforeAll(async () => {
  db = await createTestDb()
  const role = await db.prisma.role.create({ data: { name: "R" } })
  const eq = await db.prisma.equipment.create({ data: { name: "EQ" } })
  const hidden = await db.prisma.equipment.create({ data: { name: "EQ2", roles: { connect: [{ id: role.id }] } } })
  consoleId = (await db.prisma.serialConsole.create({ data: { equipmentId: eq.id, position: 0, key: "A", label: "A" } })).id
  hiddenId = (await db.prisma.serialConsole.create({ data: { equipmentId: hidden.id, position: 0, key: "B", label: "B" } })).id
})
afterAll(async () => { await db.cleanup() })
beforeEach(() => {
  rt = fakeRuntime({ prisma: db.prisma, config: testConfig() })
  rt.ops.health.run = async (opts) => {
    onlyAsked = opts?.only
    return [check("serial.dialout"), check("serial.devices"), check("data.backups")]
  }
  rt.serial.consoles.listCaptureFiles = async (id, opts) => [{ name: `${id}-${opts.includeInput}`, date: "2026-09-23", sizeBytes: 1, compressed: false, modifiedAt: "2026-09-23T10:00:00.000Z", input: false }]
  setRuntime(rt)
})

describe("getSerialPageData", () => {
  it("admin: snapshot + only the serial hint checks + policy flags", async () => {
    const d = await getSerialPageData(user({ isAdmin: true }))
    expect(d.snapshot).toMatchObject({ adapters: [], others: [] })
    expect(onlyAsked).toEqual(["serial.dialout", "serial.devices", "serial.modemmanager", "serial.brltty"])
    expect(d.serialHints.map((h) => h.id)).toEqual(["serial.dialout", "serial.devices"])
    expect(d).toMatchObject({ allowPoke: true, hideJtag: true })
  })
  it("non-admin → FORBIDDEN", async () => {
    const err = await getSerialPageData(user()).then(() => null, (e: unknown) => e)
    expect(isDomainError(err) && err.code).toBe("FORBIDDEN")
  })
  it("a failing health run leaves the hints empty", async () => {
    rt.ops.health.run = async () => { throw new Error("x") }
    expect((await getSerialPageData(user({ isAdmin: true }))).serialHints).toEqual([])
  })
})

describe("getConsoleCaptureFiles", () => {
  it("visible console only; input files only for admins", async () => {
    expect((await getConsoleCaptureFiles(user(), consoleId)).map((f) => f.name)).toEqual([`${consoleId}-false`])
    expect((await getConsoleCaptureFiles(user({ isAdmin: true }), consoleId)).map((f) => f.name)).toEqual([`${consoleId}-true`])
    expect(await getConsoleCaptureFiles(user(), hiddenId)).toEqual([])
    expect(await getConsoleCaptureFiles(user(), "../x")).toEqual([])
  })
})
