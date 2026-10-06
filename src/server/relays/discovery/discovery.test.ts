import dgram from "node:dgram"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createNullLogger } from "@/server/log"
import type { AppConfig } from "@/server/config/schema"
import { fakeAudit, fakeBus, testConfig } from "../../../../test/helpers"
import { createSimulator, type Simulator, type SimulatorOptions } from "../../../../scripts/sim/devantech-sim.mjs"
import { createDriverRegistry, type DriverRegistry } from "../registry"
import { defaultTransports } from "../transport"
import { createRelayDiscovery, type RelayDiscoveryDeps, type RelayDiscoveryImpl } from "./index"

async function freeUdpPort(): Promise<number> {
  const s = dgram.createSocket("udp4")
  await new Promise<void>((r) => s.bind(0, "0.0.0.0", () => r()))
  const port = s.address().port
  await new Promise<void>((r) => s.close(() => r()))
  return port
}
const CRLF = [0x0d, 0x0a]
function announcement(mac: number[], o: { hostname?: string; moduleId?: number; port?: number } = {}): Buffer {
  return Buffer.from([
    0x02, ...mac, ...CRLF,
    ...(o.hostname !== undefined ? [0x04, ...Buffer.from(o.hostname), ...CRLF] : []),
    ...CRLF, 0x40, o.moduleId ?? 35, ...CRLF,
    ...(o.port !== undefined ? [0x41, (o.port >> 8) & 0xff, o.port & 0xff, ...CRLF] : []),
  ])
}

const sims: Simulator[] = []
let disc: RelayDiscoveryImpl | null = null
afterEach(async () => {
  await disc?.stop()
  disc = null
  await Promise.all(sims.splice(0).map((s) => s.stop()))
})
async function sim(o: SimulatorOptions) { const s = await createSimulator({ log: false, ...o }); sims.push(s); return s }

const actor = { kind: "user" as const, id: "admin1", name: "admin", ip: "10.0.0.1" }
const registry = (): DriverRegistry => createDriverRegistry({ transports: defaultTransports, timeoutMs: 800, log: createNullLogger() })
function make(relays: Partial<AppConfig["relays"]>, over: Partial<RelayDiscoveryDeps> = {}) {
  const bus = fakeBus()
  const audit = fakeAudit()
  const cfg = testConfig()
  disc = createRelayDiscovery({
    config: { ...cfg, relays: { ...cfg.relays, passiveDiscovery: false, simulate: true, ...relays } },
    log: createNullLogger(), bus, audit, registry: registry(), boards: () => [], networkInterfaces: () => ({}),
    timing: { repeats: 3, intervalMs: 100, collectMs: 400 },
    ...over,
  })
  return { d: disc, bus, audit }
}

describe("active UDP discovery", () => {
  it("finds both simulators on loopback, dedupes by MAC and enriches them read-only", async () => {
    const port = await freeUdpPort()
    const ds = await sim({ model: "dS378", host: "127.0.0.2", ascii: 0, udp: true, udpPort: port, mac: "00:04:a3:00:00:01", toggleVar: "V20552" })
    const eth = await sim({ model: "ETH008", host: "127.0.0.3", eth: 0, user: "admin", pass: "password", udp: true, udpPort: port, mac: "00:04:a3:00:00:02" })
    const { d, audit, bus } = make({ discoveryPort: port, broadcastTargets: ["127.255.255.255"] })
    const r = await d.discoverUdp(actor)
    expect(r).toMatchObject({ kind: "udp", targets: ["127.255.255.255"], warnings: [] })
    expect(r.boards.map((b) => b.key).sort()).toEqual(["00:04:a3:00:00:01", "00:04:a3:00:00:02"])
    const b1 = r.boards.find((b) => b.mac === ds.mac)
    expect(b1).toMatchObject({ ip: "127.0.0.2", model: "dS378", moduleId: 35, tcpPort: ds.ports.ascii, httpPort: ds.ports.http,
      reachable: true, sources: ["udp-active"], registeredBoardId: null, ipChanged: false })
    expect(b1?.detect).toMatchObject({ driver: "devantech-ds-ascii", relayCount: 8, options: { toggleVar: "V20552" } })
    expect(b1?.hints).toContain("OUI Microchip")
    const b2 = r.boards.find((b) => b.mac === eth.mac)
    expect(b2).toMatchObject({ ip: "127.0.0.3", model: "ETH008", reachable: true })
    expect(b2?.detect).toMatchObject({ driver: "devantech-eth", relayCount: 8 })
    expect(d.known()).toHaveLength(2)
    expect(d.find("00:04:a3:00:00:01")?.ip).toBe("127.0.0.2")
    expect(audit.inputs.find((i) => i.action === "discovery.relay.udp")).toMatchObject({ actor, detail: { targets: ["127.255.255.255"], found: 2 } })
    expect(bus.events.filter((e) => e.event.type === "relay.discovered").every((e) => e.audience.kind === "admins")).toBe(true)
    // the enrichment never actuated a relay
    for (const s of [ds, eth]) {
      expect(s.requests.some((q) => (q.proto === "http" && (q.path === "/dscript.cgi" || q.path === "/io.cgi")) || (q.proto === "ascii" && q.line !== "ST"))).toBe(false)
    }
  })

  it("turns send errors into warnings (ENETUNREACH) and never targets 255.255.255.255", async () => {
    const port = await freeUdpPort()
    const sent: string[] = []
    const createSocket = (type: "udp4") => {
      const s = dgram.createSocket({ type, reuseAddr: true })
      const orig = s.send.bind(s) as (msg: Buffer, port: number, addr: string, cb: (e: Error | null) => void) => void
      ;(s as unknown as { send: typeof orig }).send = (msg, p, addr, cb) => {
        sent.push(addr)
        if (addr === "10.0.0.255") { cb(Object.assign(new Error("send ENETUNREACH 10.0.0.255"), { code: "ENETUNREACH" })); return }
        orig(msg, p, addr, cb)
      }
      return s
    }
    const { d } = make({ discoveryPort: port, broadcastTargets: ["127.255.255.255", "10.0.0.255"] }, { createSocket })
    const r = await d.discoverUdp(actor)
    expect(r.warnings).toContain("ENETUNREACH en 10.0.0.255: sin ruta")
    expect(sent).not.toContain("255.255.255.255")
    expect(sent.filter((a) => a === "127.255.255.255")).toHaveLength(3)
  })

  it("uses each LAN interface's directed broadcast when no override is set", async () => {
    const port = await freeUdpPort()
    const sent: string[] = []
    const createSocket = (type: "udp4") => {
      const s = dgram.createSocket({ type, reuseAddr: true })
      ;(s as unknown as { send: (m: Buffer, p: number, a: string, cb: (e: Error | null) => void) => void }).send = (_m, _p, a, cb) => { sent.push(a); cb(null) }
      return s
    }
    const ifaces = {
      eth0: [{ address: "198.51.100.118", netmask: "255.255.255.0", family: "IPv4" as const, mac: "", internal: false, cidr: "198.51.100.118/24" }],
      docker0: [{ address: "172.17.0.1", netmask: "255.255.0.0", family: "IPv4" as const, mac: "", internal: false, cidr: "172.17.0.1/16" }],
    }
    const { d } = make({ discoveryPort: port, broadcastTargets: null }, { createSocket, networkInterfaces: () => ifaces, timing: { repeats: 1, intervalMs: 10, collectMs: 50 } })
    const r = await d.discoverUdp(actor)
    expect(r.targets).toEqual(["198.51.100.255"])
    expect([...new Set(sent)]).toEqual(["198.51.100.255"])
  })

  it("caps the replies collected per run at 64 and warns about the dropped ones", async () => {
    const port = await freeUdpPort()
    const reg = registry()
    const autodetect = vi.spyOn(reg, "autodetect")
    const { d } = make({ discoveryPort: port, broadcastTargets: ["127.255.255.255"] }, { registry: reg, timing: { repeats: 1, intervalMs: 10, collectMs: 300 } })
    const run = d.discoverUdp(actor)
    await new Promise((r) => setTimeout(r, 100))
    for (let i = 0; i < 100; i++) d.ingest(announcement([0, 4, 0xa3, 7, 0, i]), `192.168.0.${i + 1}`)
    const r = await run
    expect(r.boards).toHaveLength(64)
    expect(r.warnings).toContain("Demasiadas respuestas UDP: se han descartado 36 (se atienden como máximo 64 por búsqueda)")
    expect(autodetect).not.toHaveBeenCalled()
  })

  it("enriches each IP once, even when several MACs answer from it", async () => {
    const port = await freeUdpPort()
    const reg = registry()
    const autodetect = vi.spyOn(reg, "autodetect").mockResolvedValue([])
    const { d } = make({ discoveryPort: port, broadcastTargets: ["127.255.255.255"] }, { registry: reg, timing: { repeats: 1, intervalMs: 10, collectMs: 300 } })
    const run = d.discoverUdp(actor)
    await new Promise((r) => setTimeout(r, 100))
    for (let i = 0; i < 5; i++) d.ingest(announcement([0, 4, 0xa3, 8, 0, i]), "127.0.0.9")
    const r = await run
    expect(r.boards).toHaveLength(5)
    expect(autodetect).toHaveBeenCalledTimes(1)
  })

  it("skips the enrichment probe for IPs outside the LAN subnets and broadcast networks", async () => {
    const port = await freeUdpPort()
    const reg = registry()
    const autodetect = vi.spyOn(reg, "autodetect")
    const { d } = make({ discoveryPort: port, broadcastTargets: ["127.255.255.255"] }, { registry: reg, timing: { repeats: 1, intervalMs: 10, collectMs: 300 } })
    const run = d.discoverUdp(actor)
    await new Promise((r) => setTimeout(r, 100))
    d.ingest(announcement([0, 4, 0xa3, 9, 9, 9], { hostname: "fuera", port: 17123 }), "192.168.0.123")
    const r = await run
    expect(r.boards).toHaveLength(1)
    expect(r.boards[0]).toMatchObject({ ip: "192.168.0.123", reachable: false, detect: null })
    expect(autodetect).not.toHaveBeenCalled()
  })
})

describe("passive listener and the known-boards map", () => {
  it("records announcements (no probe), cross-references DB boards by MAC and flags an IP change", async () => {
    const port = await freeUdpPort()
    const s = await sim({ model: "dS378", host: "127.0.0.2", ascii: 0, udp: true, udpPort: port, mac: "00:04:a3:00:00:07" })
    const { d, bus } = make({ discoveryPort: port, passiveDiscovery: true, broadcastTargets: ["127.255.255.255"] },
      { boards: () => [{ id: "b1", name: "Placa banco", host: "127.0.0.9", httpPort: 80, mac: "00:04:a3:00:00:07" }] })
    await d.start()
    expect(d.listening()).toBe(true)
    await s.announce()
    await vi.waitFor(() => expect(d.known()).toHaveLength(1))
    expect(d.known()[0]).toMatchObject({ key: s.mac, ip: "127.0.0.2", sources: ["udp-passive"], registeredBoardId: "b1",
      registeredBoardName: "Placa banco", ipChanged: true, detect: null })
    expect(bus.events.some((e) => e.event.type === "relay.discovered" && e.audience.kind === "admins")).toBe(true)
    expect(s.requests.filter((q) => q.proto !== "udp")).toHaveLength(0)
  })

  it("merges passive, active and scan results for the same board into one entry", async () => {
    const port = await freeUdpPort()
    const s = await sim({ model: "dS378", host: "127.0.0.2", ascii: 0, udp: true, udpPort: port, mac: "00:04:a3:00:00:08" })
    const { d } = make({ discoveryPort: port, broadcastTargets: ["127.255.255.255"] }, { scanTcpPorts: { ascii: s.ports.ascii ?? 0, eth: 1 } })
    d.ingest(announcement([0, 4, 0xa3, 0, 0, 8], { hostname: "dS378" }), "127.0.0.2")
    const sc = await d.scan({ cidrs: ["127.0.0.2/32"], ports: [s.ports.http ?? 80] }, actor)
    expect(sc.boards).toHaveLength(1)
    await d.discoverUdp(actor)
    const all = d.known()
    expect(all).toHaveLength(1)
    expect(all[0]?.key).toBe("00:04:a3:00:00:08")
    expect([...(all[0]?.sources ?? [])].sort()).toEqual(["scan", "udp-active", "udp-passive"])
    expect(all[0]?.detect?.options.toggleVar).toBe("V20944")
  })

  it("caps the map at 256 entries, evicting the oldest lastSeenAt", () => {
    let t = Date.parse("2026-09-23T10:00:00.000Z")
    const { d } = make({}, { now: () => new Date(t) })
    for (let i = 0; i < 300; i++) {
      t += 1000   // one per second: below the rate limit
      d.ingest(announcement([0, 0x1e, 0xc0, 0, i >> 8, i & 0xff]), `10.0.${i >> 8}.${(i & 0xff) || 1}`)
    }
    const keys = d.known().map((k) => k.key)
    expect(keys).toHaveLength(256)
    expect(keys).not.toContain("00:1e:c0:00:00:00")
    expect(keys).not.toContain("00:1e:c0:00:00:2b")
    expect(keys).toContain("00:1e:c0:00:00:2c")
    expect(keys).toContain("00:1e:c0:00:01:2b")
  })

  it("drops datagrams over 1472 bytes and beyond 200 per second, and reports the flood", () => {
    let t = Date.parse("2026-09-23T10:00:00.000Z")
    const { d } = make({}, { now: () => new Date(t) })
    const big = Buffer.concat([announcement([0, 4, 0xa3, 1, 1, 1]), Buffer.alloc(1500, 0x20)])
    d.ingest(big, "10.0.0.1")
    expect(d.known()).toHaveLength(0)
    for (let i = 0; i < 250; i++) d.ingest(announcement([0, 4, 0xa3, 2, i >> 8, i & 0xff]), "10.0.0.2")
    expect(d.known()).toHaveLength(200)
    expect(d.trafficExceeded()).toBe(true)
    t += 1000
    d.ingest(announcement([0, 4, 0xa3, 3, 0, 1]), "10.0.0.3")
    expect(d.known()).toHaveLength(201)
  })

  it("publishes relay.discovered on new or changed entries, otherwise at most once per 5 s per key", () => {
    let t = Date.parse("2026-09-23T10:00:00.000Z")
    const { d, bus } = make({}, { now: () => new Date(t) })
    const count = () => bus.events.filter((e) => e.event.type === "relay.discovered").length
    const mac = [0, 4, 0xa3, 5, 5, 5]
    d.ingest(announcement(mac, { hostname: "a" }), "10.0.0.5")
    expect(count()).toBe(1)
    t += 1000; d.ingest(announcement(mac, { hostname: "a" }), "10.0.0.5")
    t += 1000; d.ingest(announcement(mac, { hostname: "a" }), "10.0.0.5")
    expect(count()).toBe(1)
    t += 1000; d.ingest(announcement(mac, { hostname: "b" }), "10.0.0.5")
    expect(count()).toBe(2)
    t += 5001; d.ingest(announcement(mac, { hostname: "b" }), "10.0.0.5")
    expect(count()).toBe(3)
  })
})

describe("subnet scan", () => {
  it("shares a running scan only for the same cidrs and ports; a different one gets CONFLICT", async () => {
    let open: () => void = () => undefined
    const gate = new Promise<void>((r) => { open = r })
    const transports = { ...defaultTransports, tcpProbe: async () => { await gate; return false } }
    const { d } = make({}, { transports })
    const a = d.scan({ cidrs: ["127.0.0.2/32"], ports: [18080] }, actor)
    const same = d.scan({ cidrs: ["127.0.0.2/32"], ports: [18080] }, actor)
    await expect(d.scan({ cidrs: ["127.0.0.3/32"], ports: [18080] }, actor)).rejects.toMatchObject({
      name: "DomainError", code: "CONFLICT", message: "Ya hay un escaneo en curso" })
    await expect(d.scan({ cidrs: ["127.0.0.2/32"], ports: [18081] }, actor)).rejects.toMatchObject({ code: "CONFLICT" })
    open()
    const [ra, rs] = await Promise.all([a, same])
    expect(rs.runId).toBe(ra.runId)
    expect(ra.targets).toEqual(["127.0.0.2/32"])
    const other = await d.scan({ cidrs: ["127.0.0.3/32"], ports: [18080] }, actor)
    expect(other.runId).not.toBe(ra.runId)
    expect(other.targets).toEqual(["127.0.0.3/32"])
  })

  it("finds both simulators in 127.0.0.0/29 with the toggleVar learned, reports progress and audits", async () => {
    const ds = await sim({ model: "dS378", host: "127.0.0.2", ascii: 0, mac: "00:04:a3:00:00:01" })
    const eth = await sim({ model: "ETH008", host: "127.0.0.3", eth: 0, user: "admin", pass: "password" })
    const lo = { lo: [{ address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4" as const, mac: "", internal: true, cidr: "127.0.0.1/8" }] }
    const { d, bus, audit } = make({}, { networkInterfaces: () => lo, scanTcpPorts: { ascii: ds.ports.ascii ?? 0, eth: eth.ports.eth ?? 0 } })
    const r = await d.scan({ cidrs: ["127.0.0.0/29"], ports: [ds.ports.http ?? 0, eth.ports.http ?? 0] }, actor)
    expect(r.kind).toBe("scan")
    expect(r.targets).toEqual(["127.0.0.0/29"])
    expect(r.boards).toHaveLength(2)
    const b1 = r.boards.find((b) => b.ip === "127.0.0.2")
    expect(b1).toMatchObject({ key: `127.0.0.2:${ds.ports.http}`, httpPort: ds.ports.http, model: "dS378", sources: ["scan"], reachable: true })
    expect(b1?.detect).toMatchObject({ driver: "devantech-ds-ascii", options: { toggleVar: "V20944" } })
    const b2 = r.boards.find((b) => b.ip === "127.0.0.3")
    expect(b2?.detect).toMatchObject({ driver: "devantech-eth", model: "ETH008" })
    expect(d.find(`127.0.0.3:${eth.ports.http}`)?.model).toBe("ETH008")
    const progress = bus.events.filter((e) => e.event.type === "discovery.progress")
    expect(progress.at(-1)?.event).toMatchObject({ runId: r.runId, done: 10, total: 10 })
    expect(audit.inputs.find((i) => i.action === "discovery.relay.scan")).toMatchObject({
      detail: { cidrs: ["127.0.0.0/29"], ports: [ds.ports.http, eth.ports.http], hosts: 5, found: 2 } })
    for (const s of [ds, eth]) {
      expect(s.requests.some((q) => q.proto === "http" && (q.path === "/dscript.cgi" || q.path === "/io.cgi"))).toBe(false)
      expect(s.state().every((v) => !v)).toBe(true)
    }
  })
})
