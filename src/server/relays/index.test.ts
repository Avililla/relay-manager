import dgram from "node:dgram"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { createNullLogger } from "@/server/log"
import { createTestDb, fakeAudit, fakeBus, fakeReservations, fakeSettings, testConfig, type TestDb } from "../../../test/helpers"
import { createSimulator } from "../../../scripts/sim/devantech-sim.mjs"
import { createRelayServices } from "./index"

async function freeUdpPort(): Promise<number> {
  const s = dgram.createSocket("udp4")
  await new Promise<void>((r) => s.bind(0, "0.0.0.0", () => r()))
  const port = s.address().port
  await new Promise<void>((r) => s.close(() => r()))
  return port
}

let db: TestDb
beforeAll(async () => { db = await createTestDb() })
afterAll(async () => { await db.cleanup() })

function services(relays: Partial<ReturnType<typeof testConfig>["relays"]>) {
  const cfg = testConfig()
  return createRelayServices({
    config: { ...cfg, relays: { ...cfg.relays, ...relays } }, log: createNullLogger(), prisma: db.prisma, bus: fakeBus(),
    audit: fakeAudit(), settings: fakeSettings(), reservations: fakeReservations(),
  }, { networkInterfaces: () => ({}) })
}

describe("relay services", () => {
  it("with 0 boards: no poll timer and no socket apart from the passive UDP listener", async () => {
    const port = await freeUdpPort()
    const before = process.getActiveResourcesInfo()
    const rs = services({ passiveDiscovery: true, discoveryPort: port })
    await rs.start()
    expect(rs.internals.controller.activeTimers()).toBe(0)
    expect(rs.discovery.listening()).toBe(true)
    const after = process.getActiveResourcesInfo()
    const added = [...after]
    for (const r of before) { const i = added.indexOf(r); if (i >= 0) added.splice(i, 1) }
    expect(added).toEqual(["UDPWrap"])
    await rs.stop()
    expect(rs.discovery.listening()).toBe(false)
  })

  it("without the passive listener nothing is bound, and a bind error is not fatal", async () => {
    const rs = services({ passiveDiscovery: false })
    await rs.start()
    expect(rs.discovery.listening()).toBe(false)
    await rs.stop()
    const port = await freeUdpPort()
    const blocker = dgram.createSocket({ type: "udp4", reuseAddr: false })
    await new Promise<void>((r) => blocker.bind(port, "0.0.0.0", () => r()))
    const rs2 = services({ passiveDiscovery: true, discoveryPort: port })
    await expect(rs2.start()).resolves.toBeUndefined()
    expect(rs2.discovery.listening()).toBe(false)
    await rs2.stop()
    await new Promise<void>((r) => blocker.close(() => r()))
  })

  it("a passive announcement of a known MAC at a new IP shows 'IP cambiada' and never updates the DB (D22)", async () => {
    const port = await freeUdpPort()
    const s = await createSimulator({ log: false, model: "dS378", host: "127.0.0.2", ascii: 0, udp: true, udpPort: port, mac: "00:04:a3:0a:0b:0c" })
    const board = await db.prisma.relayBoard.create({ data: { name: "Placa del banco", driver: "devantech-ds-ascii", host: "127.0.0.9", httpPort: 80,
      mac: "00:04:a3:0a:0b:0c", relayCount: 8, enabled: false } })
    const rs = services({ passiveDiscovery: true, discoveryPort: port })
    await rs.start()
    await s.announce()
    await vi.waitFor(() => expect(rs.discovery.known()).toHaveLength(1))
    expect(rs.discovery.known()[0]).toMatchObject({ ip: "127.0.0.2", registeredBoardId: board.id, registeredBoardName: "Placa del banco", ipChanged: true })
    expect((await db.prisma.relayBoard.findUniqueOrThrow({ where: { id: board.id } })).host).toBe("127.0.0.9")
    await db.prisma.relayBoard.update({ where: { id: board.id }, data: { host: "127.0.0.2" } })
    await rs.controller.reload()
    expect(rs.discovery.find("00:04:a3:0a:0b:0c")?.ipChanged).toBe(false)
    await rs.stop()
    await s.stop()
  })
})
