import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { createTestDb, type TestDb } from "../../../test/helpers"
import { listBoardChoices } from "./board-choices"
import { fakeDomain, resetDomainTables, type FakeDomain } from "./test-fixtures"

let db: TestDb
let fx: FakeDomain

beforeAll(async () => { db = await createTestDb() })
afterAll(async () => { await db.cleanup() })
beforeEach(async () => {
  await resetDomainTables(db.prisma)
  fx = fakeDomain(db.prisma)
})

describe("listBoardChoices (§4.15)", () => {
  it("returns [] with 0 boards", async () => {
    expect(await listBoardChoices(fx.deps)).toEqual([])
  })

  it("computes free channels from Prisma and online from the controller", async () => {
    const b1 = await db.prisma.relayBoard.create({ data: { name: "B", driver: "devantech-ds-ascii", host: "10.0.0.2", relayCount: 4, model: "dS378" } })
    const b2 = await db.prisma.relayBoard.create({ data: { name: "A", driver: "devantech-eth", host: "10.0.0.3", relayCount: 2 } })
    const eq = await db.prisma.equipment.create({ data: { name: "EQ" } })
    await db.prisma.relayChannel.create({ data: { equipmentId: eq.id, boardId: b1.id, channel: 2, position: 0, label: "Alimentación" } })
    fx.boardRuntimes.set(b1.id, {
      online: true, lastSeenAt: null, lastError: null, states: [], stale: false,
      capabilities: { absoluteSet: true, toggle: "native", pulse: "native", pulseMs: null, maxRelays: 8 },
    })
    expect(await listBoardChoices(fx.deps)).toEqual([
      { id: b2.id, name: "A", model: null, relayCount: 2, freeChannels: [1, 2], online: null },
      { id: b1.id, name: "B", model: "dS378", relayCount: 4, freeChannels: [1, 3, 4], online: true },
    ])
    const forEq = await listBoardChoices(fx.deps, { forEquipmentId: eq.id })
    expect(forEq.find((b) => b.id === b1.id)?.freeChannels).toEqual([1, 2, 3, 4])
  })
})
