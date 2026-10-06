import { describe, expect, it } from "vitest"
import { RelayScanInputSchema, type DiscoveredBoardDTO } from "@/lib/contracts/relays"
import { discovery as discoveryText } from "@/lib/i18n/hardware"
import { RELAY_TEXT } from "@/lib/i18n/relays"
import {
  actionHints, defaultScanCidrs, discoveredAddress, discoveredCounts, discoveredRelayCount, discoveredState, parseCidrList, parsePortList, scanHostEstimate,
  scanInput, sortDiscovered, upsertDiscovered,
} from "./relay-model"

function board(over: Partial<DiscoveredBoardDTO> = {}): DiscoveredBoardDTO {
  return {
    key: "00:04:a3:00:00:01", sources: ["udp-passive"], firstSeenAt: "2026-09-23T10:00:00.000Z", lastSeenAt: "2026-09-23T10:00:00.000Z",
    ip: "192.168.1.40", mac: "00:04:a3:00:00:01", hostname: "dS378", model: "dS378", moduleId: 35, tcpPort: null, httpPort: 80,
    detect: null, registeredBoardId: null, registeredBoardName: null, ipChanged: false, reachable: true, hints: [],
    ...over,
  }
}

describe("discoveredState", () => {
  it("covers the four states", () => {
    expect(discoveredState(board())).toBe("new")
    expect(discoveredState(board({ reachable: false }))).toBe("unreachable")
    expect(discoveredState(board({ registeredBoardId: "b1", registeredBoardName: "Rack" }))).toBe("registered")
    expect(discoveredState(board({ registeredBoardId: "b1", registeredBoardName: "Rack", ipChanged: true }))).toBe("ip-changed")
    // a registered board is never "No alcanzable": the registered state wins
    expect(discoveredState(board({ registeredBoardId: "b1", reachable: false }))).toBe("registered")
  })

  it("counts states", () => {
    expect(discoveredCounts([board(), board({ key: "k2", reachable: false }), board({ key: "k3", registeredBoardId: "b" })]))
      .toEqual({ new: 1, registered: 1, "ip-changed": 0, unreachable: 1 })
  })
})

describe("list merging", () => {
  it("sorts numerically by IP", () => {
    const list = sortDiscovered([board({ key: "a", ip: "192.168.1.100" }), board({ key: "b", ip: "192.168.1.9" }), board({ key: "c", ip: "10.0.0.1" })])
    expect(list.map((b) => b.ip)).toEqual(["10.0.0.1", "192.168.1.9", "192.168.1.100"])
  })

  it("replaces by key and appends new keys", () => {
    const a = board({ key: "a", ip: "192.168.1.10" })
    const list = [a]
    const updated = board({ key: "a", ip: "192.168.1.10", sources: ["udp-passive", "scan"] })
    expect(upsertDiscovered(list, updated)).toEqual([updated])
    const added = upsertDiscovered(list, board({ key: "b", ip: "192.168.1.2" }))
    expect(added.map((b) => b.key)).toEqual(["b", "a"])
    expect(upsertDiscovered(list, a)).toBe(list)
  })
})

describe("row values", () => {
  it("prefers the detect result, then the announcement, then the model table", () => {
    expect(discoveredAddress(board())).toBe("192.168.1.40:80")
    expect(discoveredAddress(board({ httpPort: null }))).toBe("192.168.1.40")
    expect(discoveredRelayCount(board())).toBe(8)
    expect(discoveredRelayCount(board({ model: "Nope" }))).toBeNull()
    const detect = {
      driver: "devantech-eth" as const, confidence: "high" as const, host: "192.168.1.40", httpPort: 8080, tcpPort: 17494, model: "ETH008",
      moduleId: 19, relayCount: 8, hostname: null, mac: null, firmware: "4.1", authRequired: false, options: {}, evidence: [],
    }
    expect(discoveredAddress(board({ httpPort: null, detect }))).toBe("192.168.1.40:8080")
    expect(discoveredRelayCount(board({ model: null, detect }))).toBe(8)
  })
})

describe("scan dialog", () => {
  it("parses CIDRs one per line and flags invalid ones", () => {
    expect(parseCidrList("192.168.1.0/24\n10.0.0.0/22, 10.0.0.0/22")).toEqual({ cidrs: ["192.168.1.0/24", "10.0.0.0/22"], invalid: [] })
    expect(parseCidrList("10.0.0.0/16\n300.1.1.0/24\nfoo").invalid).toEqual(["10.0.0.0/16", "300.1.1.0/24", "foo"])
  })

  it("parses 1 to 4 ports", () => {
    expect(parsePortList("80, 8080")).toEqual([80, 8080])
    expect(parsePortList("")).toBeNull()
    expect(parsePortList("1 2 3 4 5")).toBeNull()
    expect(parsePortList("80, 70000")).toBeNull()
    expect(parsePortList("80x")).toBeNull()
  })

  it("estimates the probed hosts like the server (capped at 2048)", () => {
    expect(scanHostEstimate(["192.168.1.0/24"])).toBe(254)
    expect(scanHostEstimate(["127.0.0.0/29", "10.0.0.5/32"])).toBe(7)
    expect(scanHostEstimate(["10.0.0.0/22", "10.0.4.0/22", "10.0.8.0/22"])).toBe(2048)
  })

  it("returns the action input or the problems", () => {
    const ok = scanInput({ cidrs: "192.168.1.0/24", ports: "80" })
    expect(ok).toEqual({ ok: true, cidrs: ["192.168.1.0/24"], ports: [80] })
    if (ok.ok) expect(RelayScanInputSchema.safeParse({ cidrs: ok.cidrs, ports: ok.ports }).success).toBe(true)
    expect(scanInput({ cidrs: "", ports: "80" })).toEqual({ ok: false, cidrs: { kind: "empty" }, ports: false })
    expect(scanInput({ cidrs: "10.0.0.0/8", ports: "" })).toEqual({ ok: false, cidrs: { kind: "invalid", value: "10.0.0.0/8" }, ports: true })
    const nine = Array.from({ length: 9 }, (_, i) => `10.0.${i}.0/24`).join("\n")
    expect(scanInput({ cidrs: nine, ports: "80" })).toEqual({ ok: false, cidrs: { kind: "too-many" }, ports: false })
  })

  it("defaults to the /24 of each LAN interface", () => {
    const ifaces = {
      lo: [{ address: "127.0.0.1", family: "IPv4", internal: true, cidr: "127.0.0.1/8" }],
      enp3s0: [{ address: "198.51.100.17", family: "IPv4", internal: false, cidr: "198.51.100.17/24" }, { address: "fe80::1", family: "IPv6", internal: false, cidr: "fe80::1/64" }],
      eno1: [{ address: "10.20.0.5", family: "IPv4", internal: false, cidr: "10.20.0.5/16" }],
      docker0: [{ address: "172.17.0.1", family: "IPv4", internal: false, cidr: "172.17.0.1/16" }],
      wg0: [{ address: "10.99.0.2", family: "IPv4", internal: false, cidr: "10.99.0.2/32" }],
    }
    expect(defaultScanCidrs(ifaces)).toEqual(["198.51.100.0/24", "10.20.0.0/24"])
  })
})

describe("scan warning copy (fix round 1)", () => {
  it("drops the address count while the networks do not parse", () => {
    expect(discoveryText.scanWarning(null)).not.toMatch(/\d/)
    expect(discoveryText.scanWarning(14)).toContain("hasta 14 direcciones")
    expect(discoveryText.scanWarning(1)).toContain("hasta 1 dirección ")
  })
})

describe("actionHints (only hints that call for action are shown under each board)", () => {
  it("drops the informational «OUI Microchip»", () => {
    expect(actionHints([RELAY_TEXT.hintMicrochip, RELAY_TEXT.hintOtherIp("10.0.0.9")])).toEqual([RELAY_TEXT.hintOtherIp("10.0.0.9")])
    expect(actionHints([RELAY_TEXT.hintMicrochip])).toEqual([])
  })
})
