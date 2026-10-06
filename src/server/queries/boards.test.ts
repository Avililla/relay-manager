import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { DomainError } from "@/server/errors"
import { setRuntime } from "@/server/runtime/registry"
import type { AuthUser, RelayController } from "@/server/runtime/types"
import type { DiscoveredBoardDTO } from "@/lib/contracts/relays"
import { createTestDb, fakeRuntime, type TestDb } from "../../../test/helpers"
import { getBoardDetail, listBoards } from "./boards"
import { getDiscoveredBoard, getDiscoveredBoards } from "./relay-discovery"

const state = vi.hoisted(() => ({ user: null as AuthUser | null }))
vi.mock("@/server/authz", () => ({
  requireAdmin: async () => {
    if (!state.user) throw new DomainError("UNAUTHENTICATED", "Sin sesión")
    if (!state.user.isAdmin) throw new DomainError("FORBIDDEN", "No tienes permiso")
    return state.user
  },
}))

const ADMIN: AuthUser = { id: "a", username: "admin", name: "Admin", isAdmin: true, roleIds: [], mustChangePassword: false, sessionVersion: 1 }
let db: TestDb
let boardA = ""
let boardB = ""
const discovered: DiscoveredBoardDTO = {
  key: "00:04:a3:00:00:01", sources: ["udp-passive"], firstSeenAt: "2026-09-23T10:00:00.000Z", lastSeenAt: "2026-09-23T10:00:01.000Z",
  ip: "127.0.0.2", mac: "00:04:a3:00:00:01", hostname: "dS378", model: "dS378", moduleId: 35, tcpPort: 17123, httpPort: 80,
  detect: null, registeredBoardId: null, registeredBoardName: null, ipChanged: false, reachable: true, hints: [],
}

beforeAll(async () => {
  db = await createTestDb()
  const a = await db.prisma.relayBoard.create({ data: { name: "Placa B", driver: "devantech-ds-ascii", host: "10.0.0.2", relayCount: 4, password: "x", options: { useHttpFallback: true } } })
  const b = await db.prisma.relayBoard.create({ data: { name: "Placa A", driver: "devantech-eth", host: "10.0.0.3", model: "ETH008", relayCount: 8, enabled: false, lastError: "sin respuesta", options: { junk: 1 } } })
  boardA = a.id
  boardB = b.id
  const e1 = await db.prisma.equipment.create({ data: { name: "Equipo A #01" } })
  const e2 = await db.prisma.equipment.create({ data: { name: "Equipo A #02" } })
  await db.prisma.relayChannel.create({ data: { equipmentId: e1.id, boardId: a.id, channel: 1, position: 0, label: "Alimentación", purpose: "power" } })
  await db.prisma.relayChannel.create({ data: { equipmentId: e1.id, boardId: a.id, channel: 3, position: 1, label: "Reinicio", purpose: "reset" } })
  await db.prisma.relayChannel.create({ data: { equipmentId: e2.id, boardId: a.id, channel: 4, position: 0, label: "Modo", purpose: "mode" } })
  const live = { online: true, lastSeenAt: "2026-09-23T10:00:00.000Z", lastError: null, states: [true, false, false, true], stale: false,
    capabilities: { absoluteSet: true, toggle: "emulated" as const, pulse: "native" as const, pulseMs: { min: 19, max: 2147483647, step: 1 }, maxRelays: 32 } }
  const rt = fakeRuntime({ prisma: db.prisma })
  const controller: RelayController = { ...rt.relays.controller, boardRuntime: (id) => (id === a.id ? live : null) }
  setRuntime({ ...rt, relays: { ...rt.relays, controller, discovery: { ...rt.relays.discovery, known: () => [discovered], find: (k) => (k === discovered.key ? discovered : null) } } })
})
afterAll(async () => { await db.cleanup() })

describe("board queries", () => {
  it("listBoards: sorted by name, counts, hasPassword only, live runtime or the persisted fallback", async () => {
    state.user = ADMIN
    const list = await listBoards()
    expect(list.map((b) => b.name)).toEqual(["Placa A", "Placa B"])
    const [eth, ds] = list
    expect(ds).toMatchObject({ id: boardA, hasPassword: true, usedChannels: 3, equipmentCount: 2, options: { useHttpFallback: true }, runtime: { online: true } })
    expect(JSON.stringify(ds)).not.toContain("\"password\"")
    expect(eth).toMatchObject({ id: boardB, enabled: false, options: {}, runtime: { online: null, stale: true, lastError: "sin respuesta", states: new Array(8).fill(null), capabilities: { maxRelays: 8 } } })
  })

  it("getBoardDetail: one tile per physical channel with state and binding", async () => {
    state.user = ADMIN
    const d = await getBoardDetail(boardA)
    expect(d?.channels).toHaveLength(4)
    expect(d?.channels[0]).toMatchObject({ channel: 1, state: true, binding: { equipmentName: "Equipo A #01", label: "Alimentación", purpose: "power" } })
    expect(d?.channels[1]).toEqual({ channel: 2, state: false, binding: null })
    expect(d?.channels[3]).toMatchObject({ channel: 4, state: true, binding: { equipmentName: "Equipo A #02", purpose: "mode" } })
    expect(await getBoardDetail("nope")).toBeNull()
    expect(await getBoardDetail("../x")).toBeNull()
  })

  it("discovered boards come from the known map; admins only", async () => {
    state.user = ADMIN
    expect(await getDiscoveredBoards()).toEqual([discovered])
    expect(await getDiscoveredBoard(discovered.key)).toEqual(discovered)
    expect(await getDiscoveredBoard("desconocida")).toBeNull()
    state.user = { ...ADMIN, isAdmin: false }
    await expect(listBoards()).rejects.toMatchObject({ code: "FORBIDDEN" })
    await expect(getDiscoveredBoards()).rejects.toMatchObject({ code: "FORBIDDEN" })
  })
})
