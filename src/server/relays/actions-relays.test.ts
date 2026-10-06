// Integration tests of the W1-B server actions (src/actions/{relays,boards,relay-discovery}.ts) with the real relay
// services. They live here because src/actions/** may not import Graph A modules (§2.2 rule 7), tests included.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { createNullLogger } from "@/server/log"
import { setRuntime } from "@/server/runtime/registry"
import type { AuthUser } from "@/server/runtime/types"
import { createRelayServices, type RelayServicesImpl } from "./index"
import { createTestDb, fakeAudit, fakeBus, fakeReservations, fakeRuntime, fakeSettings, makeUser, testConfig, type TestDb } from "../../../test/helpers"
import { createSimulator, type Simulator } from "../../../scripts/sim/devantech-sim.mjs"
import { createBoard } from "@/actions/boards"
import { pulseRelay, refreshEquipmentRelays, setRelay } from "@/actions/relays"

const state = vi.hoisted(() => ({ user: null as AuthUser | null }))
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-forwarded-for": "10.0.0.7" }) }))
vi.mock("next/cache", () => ({ revalidatePath: () => {} }))
vi.mock("@/server/authz", () => ({ getAuthUser: async () => state.user }))

const asUser = (u: { id: string; username: string; name: string; isAdmin: boolean; roles: Array<{ id: string }> }): AuthUser =>
  ({ id: u.id, username: u.username, name: u.name, isAdmin: u.isAdmin, roleIds: u.roles.map((r) => r.id), mustChangePassword: false, sessionVersion: 1 })

let db: TestDb
let sim: Simulator
let services: RelayServicesImpl
let audit: ReturnType<typeof fakeAudit>
let reservations: ReturnType<typeof fakeReservations>
let admin: AuthUser, holder: AuthUser, other: AuthUser, outsider: AuthUser
let eqId = "", powerId = "", resetId = ""

beforeAll(async () => {
  db = await createTestDb()
  sim = await createSimulator({ log: false, model: "dS378", ascii: 0 })
  audit = fakeAudit()
  reservations = fakeReservations()
  const bus = fakeBus()
  const cfg = testConfig()
  services = createRelayServices({
    config: { ...cfg, relays: { ...cfg.relays, passiveDiscovery: false } }, log: createNullLogger(), prisma: db.prisma, bus,
    audit, settings: fakeSettings(), reservations,
  })
  await services.start()
  setRuntime(fakeRuntime({ prisma: db.prisma, audit, bus, reservations, relays: services }))

  const lab = await db.prisma.role.create({ data: { name: "Laboratorio" } })
  const otherRole = await db.prisma.role.create({ data: { name: "Otro grupo" } })
  admin = asUser(await makeUser(db.prisma, { username: "admin", isAdmin: true }))
  holder = asUser(await makeUser(db.prisma, { username: "operador", roleIds: [lab.id] }))
  other = asUser(await makeUser(db.prisma, { username: "colega", roleIds: [lab.id] }))
  outsider = asUser(await makeUser(db.prisma, { username: "ajeno", roleIds: [otherRole.id] }))

  // The admin registers the board through the real action.
  state.user = admin
  const created = await createBoard({ name: "dS378 banco", driver: "devantech-ds-ascii", host: "127.0.0.1", httpPort: sim.ports.http ?? 80,
    tcpPort: sim.ports.ascii, model: "dS378", relayCount: 8 })
  expect(created.ok).toBe(true)
  const boardId = created.ok ? created.data.id : ""
  const eq = await db.prisma.equipment.create({ data: { name: "Equipo A #01", roles: { connect: [{ id: lab.id }] } } })
  eqId = eq.id
  powerId = (await db.prisma.relayChannel.create({ data: { equipmentId: eq.id, boardId, channel: 1, position: 0, key: "POWER", label: "Alimentación", purpose: "power", requireConfirm: true } })).id
  resetId = (await db.prisma.relayChannel.create({ data: { equipmentId: eq.id, boardId, channel: 2, position: 1, key: "RESET", label: "Reinicio", purpose: "reset" } })).id
  await services.controller.reload()
})
afterAll(async () => {
  await services.stop()
  await sim.stop()
  await db.cleanup()
})
beforeEach(() => {
  audit.inputs.length = 0
  reservations.holders.clear()
})

describe("setRelay (acceptance: ds-ascii board bound to an equipment channel)", () => {
  it("refuses a user who cannot see the equipment with NOT_FOUND, even if a reservation says otherwise", async () => {
    reservations.holders.set(eqId, outsider.id)
    state.user = outsider
    const r = await setRelay({ equipmentId: eqId, channelId: powerId, on: true })
    expect(r).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } })
    expect(sim.state()[0]).toBe(false)
    expect(sim.requests.filter((q) => q.proto === "ascii" && q.line.startsWith("SR"))).toHaveLength(0)
  })

  it("refuses a user who sees it but does not hold the reservation (NOT_HOLDER, audited as denied)", async () => {
    reservations.holders.set(eqId, holder.id)
    state.user = other
    const r = await setRelay({ equipmentId: eqId, channelId: powerId, on: true })
    expect(r).toMatchObject({ ok: false, error: { code: "NOT_HOLDER", message: "Reserva el equipo para usar sus relés." } })
    expect(audit.inputs).toEqual([expect.objectContaining({ action: "relay.set", outcome: "denied", detail: { code: "NOT_HOLDER" } })])
    expect(sim.state()[0]).toBe(false)
  })

  it("lets the holder switch ON; OFF on a power relay needs confirmation; the simulator state matches", async () => {
    reservations.holders.set(eqId, holder.id)
    state.user = holder
    const on = await setRelay({ equipmentId: eqId, channelId: powerId, on: true })
    expect(on).toEqual({ ok: true, data: { channelId: powerId, on: true, stale: false } })
    expect(sim.state()[0]).toBe(true)
    expect(audit.inputs.find((i) => i.action === "relay.set")).toMatchObject({ outcome: "ok", actor: { id: holder.id, ip: "10.0.0.7" },
      detail: { channel: 1, after: true, verified: true } })

    const off = await setRelay({ equipmentId: eqId, channelId: powerId, on: false })
    expect(off).toMatchObject({ ok: false, error: { code: "CONFIRMATION_REQUIRED" } })
    expect(sim.state()[0]).toBe(true)
    const confirmed = await setRelay({ equipmentId: eqId, channelId: powerId, on: false, confirmed: true })
    expect(confirmed).toMatchObject({ ok: true, data: { on: false } })
    expect(sim.state()[0]).toBe(false)
  })

  it("pulses (native on ds-ascii); a requireConfirm channel needs confirmation; bad input → VALIDATION", async () => {
    reservations.holders.set(eqId, holder.id)
    state.user = holder
    expect(await pulseRelay({ equipmentId: eqId, channelId: powerId, ms: 500 })).toMatchObject({ ok: false, error: { code: "CONFIRMATION_REQUIRED" } })
    expect(await pulseRelay({ equipmentId: eqId, channelId: resetId, ms: 300 })).toEqual({ ok: true, data: null })
    expect(sim.requests.some((q) => q.proto === "ascii" && q.line === "SR 2 on 300")).toBe(true)
    expect(await pulseRelay({ equipmentId: eqId, channelId: resetId, ms: 10 })).toMatchObject({ ok: false, error: { code: "VALIDATION", fieldErrors: { ms: expect.any(Array) } } })
    expect(await setRelay({ equipmentId: "bad id!", channelId: powerId, on: true })).toMatchObject({ ok: false, error: { code: "VALIDATION" } })
    expect(await setRelay({ equipmentId: eqId, channelId: "doesnotexist", on: true })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } })
  })

  it("refreshEquipmentRelays: any viewer, visible equipment only", async () => {
    sim.setRelay(2, true)
    state.user = other
    const r = await refreshEquipmentRelays({ equipmentId: eqId })
    expect(r.ok && r.data).toEqual([{ channelId: powerId, on: false, stale: false }, { channelId: resetId, on: true, stale: false }])
    state.user = outsider
    expect(await refreshEquipmentRelays({ equipmentId: eqId })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } })
    state.user = null
    expect(await refreshEquipmentRelays({ equipmentId: eqId })).toMatchObject({ ok: false, error: { code: "UNAUTHENTICATED" } })
    sim.setRelay(2, false)
  })
})
