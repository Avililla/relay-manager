// Integration tests of the W1-B server actions (src/actions/{relays,boards,relay-discovery}.ts) with the real relay
// services. They live here because src/actions/** may not import Graph A modules (§2.2 rule 7), tests included.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { createNullLogger } from "@/server/log"
import { setRuntime } from "@/server/runtime/registry"
import type { AuthUser } from "@/server/runtime/types"
import { createRelayServices, type RelayServicesImpl } from "./index"
import { createTestDb, fakeAudit, fakeBus, fakeReservations, fakeRuntime, fakeSettings, testConfig, type TestDb } from "../../../test/helpers"
import { createSimulator, type Simulator } from "../../../scripts/sim/devantech-sim.mjs"
import { createBoard, deleteBoard, refreshBoard, setBoardEnabled, testBoardConnection, updateBoard, updateBoardHost } from "@/actions/boards"
import { runRelaySubnetScan, runRelayUdpDiscovery } from "@/actions/relay-discovery"

const state = vi.hoisted(() => ({ user: null as AuthUser | null }))
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-forwarded-for": "10.0.0.2" }) }))
vi.mock("next/cache", () => ({ revalidatePath: () => {} }))
vi.mock("@/server/authz", () => ({ getAuthUser: async () => state.user }))

const ADMIN: AuthUser = { id: "adm1", username: "admin", name: "Admin", isAdmin: true, roleIds: [], mustChangePassword: false, sessionVersion: 1 }
const USER: AuthUser = { ...ADMIN, id: "usr1", username: "operador", isAdmin: false }

let db: TestDb
let sim: Simulator
let services: RelayServicesImpl
let audit: ReturnType<typeof fakeAudit>
let bus: ReturnType<typeof fakeBus>
let simulate = false

beforeAll(async () => {
  db = await createTestDb()
  sim = await createSimulator({ log: false, model: "dS378", ascii: 0, toggleVar: "V20552", hostname: "rele-banco" })
  audit = fakeAudit()
  bus = fakeBus()
  const cfg = testConfig()
  services = createRelayServices({
    config: { ...cfg, relays: { ...cfg.relays, passiveDiscovery: false, simulate: false } }, log: createNullLogger(), prisma: db.prisma,
    bus, audit, settings: fakeSettings(), reservations: fakeReservations(),
  })
  await services.start()
})
afterAll(async () => {
  await services.stop()
  await sim.stop()
  await db.cleanup()
})
beforeEach(async () => {
  await db.prisma.relayChannel.deleteMany()
  await db.prisma.relayBoard.deleteMany()
  await db.prisma.equipment.deleteMany()
  await services.controller.reload()
  audit.inputs.length = 0
  bus.events.length = 0
  simulate = false
  const relays = { ...services, simulatedAllowed: () => simulate }
  setRuntime(fakeRuntime({ prisma: db.prisma, audit, bus, relays }))
  state.user = ADMIN
})

const base = () => ({ name: "Placa 1", driver: "devantech-ds-ascii" as const, host: "127.0.0.1", httpPort: sim.ports.http ?? 80, tcpPort: sim.ports.ascii, relayCount: 8, model: "dS378" })

describe("board actions", () => {
  it("are admin only (FORBIDDEN is audited as auth.denied)", async () => {
    state.user = USER
    expect(await createBoard(base())).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } })
    expect(await runRelayUdpDiscovery({})).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } })
    expect(audit.inputs.map((i) => [i.action, i.outcome])).toEqual([["auth.denied", "denied"], ["auth.denied", "denied"]])
  })

  it("create: stores the board, starts polling it, audits without the password", async () => {
    const r = await createBoard({ ...base(), password: "secreto-1", username: "admin" })
    expect(r.ok).toBe(true)
    const id = r.ok ? r.data.id : ""
    const row = await db.prisma.relayBoard.findUniqueOrThrow({ where: { id } })
    expect(row).toMatchObject({ name: "Placa 1", driver: "devantech-ds-ascii", relayCount: 8, password: "secreto-1", enabled: true })
    const a = audit.inputs.find((i) => i.action === "board.create")
    expect(a).toMatchObject({ target: { type: "board", id, name: "Placa 1" }, detail: { credentialSet: true } })
    expect(JSON.stringify(a)).not.toContain("secreto-1")
    await vi.waitFor(() => expect(services.controller.boardRuntime(id)?.online).toBe(true))
  })

  it("create: simulated only with RM_RELAY_SIMULATE=1, relay count per driver, unique name/address/MAC", async () => {
    expect(await createBoard({ ...base(), driver: "simulated" })).toMatchObject({ ok: false, error: { code: "VALIDATION", fieldErrors: { driver: ["El controlador simulado solo está disponible con RM_RELAY_SIMULATE=1"] } } })
    simulate = true
    expect((await createBoard({ ...base(), name: "Sim", host: "127.0.0.9", driver: "simulated" })).ok).toBe(true)
    expect(await createBoard({ ...base(), name: "ETH", driver: "devantech-eth", model: "ETH484", relayCount: 8, host: "127.0.0.8" }))
      .toMatchObject({ ok: false, error: { code: "VALIDATION", fieldErrors: { relayCount: ["Este controlador admite como máximo 4 relés"] } } })
    expect((await createBoard({ ...base(), mac: "00:04:A3:00:00:01" })).ok).toBe(true)
    const dup = await createBoard({ ...base(), mac: "00:04:a3:00:00:01" })
    expect(dup).toMatchObject({ ok: false, error: { code: "CONFLICT", fieldErrors: { name: expect.any(Array), host: expect.any(Array), mac: expect.any(Array) } } })
    expect(await createBoard({ ...base(), host: "http://x" })).toMatchObject({ ok: false, error: { code: "VALIDATION", fieldErrors: { host: expect.any(Array) } } })
  })

  it("update: password undefined keeps it, null clears it; relayCount cannot drop below a bound channel", async () => {
    const r = await createBoard({ ...base(), password: "uno-1234" })
    const id = r.ok ? r.data.id : ""
    const eq = await db.prisma.equipment.create({ data: { name: "Equipo A #09" } })
    await db.prisma.relayChannel.create({ data: { equipmentId: eq.id, boardId: id, channel: 6, position: 0, label: "Aux" } })
    expect((await updateBoard({ ...base(), boardId: id, name: "Placa 1b" })).ok).toBe(true)
    expect((await db.prisma.relayBoard.findUniqueOrThrow({ where: { id } })).password).toBe("uno-1234")
    const upd = audit.inputs.find((i) => i.action === "board.update")
    expect(upd?.detail).toMatchObject({ changed: { name: ["Placa 1", "Placa 1b"] }, credentialChanged: false })
    expect((await updateBoard({ ...base(), boardId: id, name: "Placa 1b", password: null })).ok).toBe(true)
    expect((await db.prisma.relayBoard.findUniqueOrThrow({ where: { id } })).password).toBeNull()
    expect(await updateBoard({ ...base(), boardId: id, relayCount: 4 })).toMatchObject({ ok: false, error: { code: "VALIDATION", fieldErrors: { relayCount: [expect.stringContaining("canal 6")] } } })
    expect(JSON.stringify(audit.inputs)).not.toContain("uno-1234")
  })

  it("delete: type-to-confirm; detaches the channels and keeps the equipment", async () => {
    const r = await createBoard(base())
    const id = r.ok ? r.data.id : ""
    const eq = await db.prisma.equipment.create({ data: { name: "Equipo A #10" } })
    await db.prisma.relayChannel.create({ data: { equipmentId: eq.id, boardId: id, channel: 1, position: 0, label: "Alimentación" } })
    expect(await deleteBoard({ boardId: id, confirmName: "otra" })).toMatchObject({ ok: false, error: { code: "VALIDATION", fieldErrors: { confirmName: expect.any(Array) } } })
    expect(await deleteBoard({ boardId: id, confirmName: "Placa 1" })).toEqual({ ok: true, data: { detachedChannels: 1 } })
    expect(await db.prisma.equipment.count({ where: { id: eq.id } })).toBe(1)
    expect(await db.prisma.relayChannel.count()).toBe(0)
    expect(bus.events).toContainEqual({ event: { type: "equipment.changed", equipmentId: eq.id, change: "updated" }, audience: { kind: "all" } })
    expect(audit.inputs.find((i) => i.action === "board.delete")?.detail).toMatchObject({ detachedChannels: 1, equipment: ["Equipo A #10"] })
    expect(services.controller.boardRuntime(id)).toBeNull()
  })

  it("enable/disable is audited and stops polling; refresh returns the runtime", async () => {
    const r = await createBoard(base())
    const id = r.ok ? r.data.id : ""
    expect(await setBoardEnabled({ boardId: id, enabled: false })).toEqual({ ok: true, data: null })
    expect(audit.inputs.at(-1)).toMatchObject({ action: "board.disable", target: { id } })
    expect(services.internals.controller.activeTimers()).toBe(0)
    expect(await setBoardEnabled({ boardId: id, enabled: true })).toEqual({ ok: true, data: null })
    expect(audit.inputs.at(-1)?.action).toBe("board.enable")
    const rb = await refreshBoard({ boardId: id })
    expect(rb).toMatchObject({ ok: true, data: { online: true, stale: false, states: new Array(8).fill(false) } })
  })

  it("testBoardConnection is read-only, suggests ds-ascii with the learned toggleVar, and is audited", async () => {
    const r = await testBoardConnection({ host: "127.0.0.1", httpPort: sim.ports.http ?? 80, tcpPort: sim.ports.ascii })
    expect(r.ok && r.data[0]).toMatchObject({ driver: "devantech-ds-ascii", model: "dS378", relayCount: 8, hostname: "rele-banco", options: { toggleVar: "V20552" } })
    expect(audit.inputs.find((i) => i.action === "board.test")).toBeTruthy()
    expect(await db.prisma.relayBoard.count()).toBe(0)
    expect(await testBoardConnection({ host: "127.0.0.1", driver: "simulated" })).toMatchObject({ ok: false, error: { code: "VALIDATION" } })
  })

  it("updateBoardHost (\"Actualizar IP\") is audited and refuses an address already registered", async () => {
    const a = await createBoard(base())
    const b = await createBoard({ ...base(), name: "Placa 2", host: "127.0.0.5" })
    const idA = a.ok ? a.data.id : ""
    expect(await updateBoardHost({ boardId: idA, host: "127.0.0.5" })).toMatchObject({ ok: false, error: { code: "CONFLICT" } })
    expect(b.ok).toBe(true)
    expect(await updateBoardHost({ boardId: idA, host: "127.0.0.6" })).toEqual({ ok: true, data: null })
    expect(audit.inputs.at(-1)).toMatchObject({ action: "board.host.update", detail: { before: "127.0.0.1", after: "127.0.0.6" } })
  })
})

describe("relay discovery actions", () => {
  it("run through the discovery service with the admin as actor; the scan input is validated", async () => {
    const r = await runRelaySubnetScan({ cidrs: ["127.0.0.1/32"], ports: [sim.ports.http ?? 80] })
    expect(r).toMatchObject({ ok: true, data: { kind: "scan", targets: ["127.0.0.1/32"] } })
    expect(audit.inputs.find((i) => i.action === "discovery.relay.scan")).toMatchObject({ actor: { id: ADMIN.id, ip: "10.0.0.2" } })
    expect(await runRelaySubnetScan({ cidrs: ["10.0.0.0/16"] })).toMatchObject({ ok: false, error: { code: "VALIDATION", fieldErrors: { "cidrs.0": expect.any(Array) } } })
    expect(await runRelaySubnetScan({ ports: [1, 2, 3, 4, 5] })).toMatchObject({ ok: false, error: { code: "VALIDATION" } })
  })
})
