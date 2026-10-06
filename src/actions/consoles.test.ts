import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import type { ConsoleRuntimeDTO } from "@/lib/contracts/serial"
import { setRuntime } from "@/server/runtime/registry"
import type { ActorRef, AuthUser, Runtime } from "@/server/runtime/types"
import { createTestDb, fakeAudit, fakeReservations, fakeRuntime, testConfig, type TestDb } from "../../test/helpers"
import { clearConsoleHistory, identifyPorts, pokePort, releaseConsolePort, rescanSerial, retakeConsolePort } from "./consoles"

const state = vi.hoisted(() => ({ user: null as AuthUser | null }))
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-forwarded-for": "10.0.0.7" }) }))
vi.mock("@/server/authz", () => ({ getAuthUser: async () => state.user }))

const user = (over: Partial<AuthUser> = {}): AuthUser => ({
  id: "u1", username: "ana", name: "Ana", isAdmin: false, roleIds: [], mustChangePassword: false, sessionVersion: 1, ...over,
})

let db: TestDb
let visibleConsole: string
let hiddenConsole: string
let eqId: string
beforeAll(async () => {
  db = await createTestDb()
  const role = await db.prisma.role.create({ data: { name: "Oculto" } })
  const eq = await db.prisma.equipment.create({ data: { name: "Equipo A #01" } })
  eqId = eq.id
  const hidden = await db.prisma.equipment.create({ data: { name: "Equipo A #02", roles: { connect: [{ id: role.id }] } } })
  visibleConsole = (await db.prisma.serialConsole.create({ data: { equipmentId: eq.id, position: 0, key: "UART0", label: "UART0" } })).id
  hiddenConsole = (await db.prisma.serialConsole.create({ data: { equipmentId: hidden.id, position: 0, key: "UART1", label: "UART1" } })).id
})
afterAll(async () => { await db.cleanup() })

const runtimeDTO: ConsoleRuntimeDTO = { status: "released", devNode: null, detail: null, since: "2026-09-23T10:00:00.000Z", lastRxAt: null, lastLine: null, viewers: 0, released: null, capture: "active" }
let calls: Array<{ op: string; id?: string; actor: ActorRef & { isAdmin?: boolean }; arg?: unknown }>
let audit: ReturnType<typeof fakeAudit>
let rt: Runtime

beforeEach(() => {
  calls = []
  audit = fakeAudit()
  rt = fakeRuntime({ prisma: db.prisma, audit, reservations: fakeReservations() })
  rt.serial.consoles.release = async (id, actor, until) => { calls.push({ op: "release", id, actor, arg: until }); return runtimeDTO }
  rt.serial.consoles.retake = async (id, actor) => { calls.push({ op: "retake", id, actor }); return { ...runtimeDTO, status: "open" } }
  rt.serial.consoles.clearHistory = async (id, actor) => { calls.push({ op: "clear", id, actor }) }
  rt.serial.probe.identify = async (keys, opts, actor) => { calls.push({ op: "identify", actor, arg: { keys, opts } }); return [] }
  rt.serial.probe.poke = async (key, opts, actor) => {
    calls.push({ op: "poke", actor, arg: { key, opts } })
    return { stableKey: key, devNode: null, state: "silent", hostname: null, openByApp: false, poked: true, sample: "", error: null, ms: 1 }
  }
  rt.serial.discovery.rescan = async (actor) => { calls.push({ op: "rescan", actor }); return rt.serial.discovery.toDTO() }
  setRuntime(rt)
  state.user = user()
})

describe("console port actions (write rule, D24)", () => {
  it("the holder may release, retake and clear", async () => {
    rt.reservations = fakeReservations({ holders: { [eqId]: "u1" } })
    expect(await releaseConsolePort({ consoleId: visibleConsole, durationMin: 15 })).toEqual({ ok: true, data: runtimeDTO })
    expect(await retakeConsolePort({ consoleId: visibleConsole })).toMatchObject({ ok: true, data: { status: "open" } })
    expect(await clearConsoleHistory({ consoleId: visibleConsole })).toEqual({ ok: true, data: null })
    expect(calls.map((c) => c.op)).toEqual(["release", "retake", "clear"])
    expect(calls[0]).toMatchObject({ id: visibleConsole, arg: 15, actor: { kind: "user", id: "u1", name: "ana", ip: "10.0.0.7", isAdmin: false } })
  })

  it("a plain user without the reservation → NOT_HOLDER, audited as denied", async () => {
    const r = await releaseConsolePort({ consoleId: visibleConsole, durationMin: null })
    expect(r).toMatchObject({ ok: false, error: { code: "NOT_HOLDER" } })
    expect(calls).toEqual([])
    expect(audit.inputs).toEqual([expect.objectContaining({ action: "console.release", outcome: "denied", detail: { code: "NOT_HOLDER" } })])
  })

  it("an admin on a free unit may; under another user's reservation → RESERVED_BY_OTHER (audited)", async () => {
    state.user = user({ id: "adm", username: "admin", isAdmin: true })
    expect((await retakeConsolePort({ consoleId: visibleConsole })).ok).toBe(true)
    rt.reservations = fakeReservations({ holders: { [eqId]: "u1" } })
    const r = await clearConsoleHistory({ consoleId: visibleConsole })
    expect(r).toMatchObject({ ok: false, error: { code: "RESERVED_BY_OTHER", details: { holderName: "u1" } } })
    expect(audit.inputs.at(-1)).toMatchObject({ action: "console.clear", outcome: "denied" })
  })

  it("an invisible or unknown console → NOT_FOUND; invalid input → VALIDATION", async () => {
    expect(await releaseConsolePort({ consoleId: hiddenConsole, durationMin: null })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } })
    expect(await retakeConsolePort({ consoleId: "nope" })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } })
    expect(await releaseConsolePort({ consoleId: visibleConsole, durationMin: 7 as 15 })).toMatchObject({ ok: false, error: { code: "VALIDATION" } })
    expect(calls).toEqual([])
  })
})

describe("admin serial actions", () => {
  it("identify/poke/rescan are admin-only (FORBIDDEN is audited)", async () => {
    expect(await identifyPorts({ stableKeys: ["virtual:/run/relay-manager/sim/ttyV0"] })).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } })
    expect(await rescanSerial({})).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } })
    expect(audit.inputs.every((i) => i.action === "auth.denied")).toBe(true)
  })

  it("identify applies the schema defaults and passes the actor", async () => {
    state.user = user({ isAdmin: true })
    expect(await identifyPorts({ stableKeys: ["virtual:/run/relay-manager/sim/ttyV0"] })).toEqual({ ok: true, data: [] })
    expect(calls[0]).toMatchObject({ op: "identify", arg: { opts: { baudRate: 115200, listenMs: 3000 } } })
    expect(await identifyPorts({ stableKeys: [] })).toMatchObject({ ok: false, error: { code: "VALIDATION" } })
  })

  it("poke needs confirmed: true and RM_SERIAL_ALLOW_POKE=1", async () => {
    state.user = user({ isAdmin: true })
    expect(await pokePort({ stableKey: "virtual:/x/sim/ttyV0", confirmed: false as true })).toMatchObject({ ok: false, error: { code: "VALIDATION" } })
    expect((await pokePort({ stableKey: "virtual:/x/sim/ttyV0", confirmed: true })).ok).toBe(true)
    rt.config = testConfig()
    rt.config.serial.allowPoke = false
    expect(await pokePort({ stableKey: "virtual:/x/sim/ttyV0", confirmed: true })).toMatchObject({ ok: false, error: { code: "DISABLED_BY_POLICY" } })
    expect(calls.filter((c) => c.op === "poke")).toHaveLength(1)
  })

  it("rescan returns the snapshot", async () => {
    state.user = user({ isAdmin: true })
    expect(await rescanSerial({})).toMatchObject({ ok: true, data: { adapters: [], others: [] } })
  })
})
