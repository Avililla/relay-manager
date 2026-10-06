import type os from "node:os"
import { describe, expect, it } from "vitest"
import {
  broadcastNetworks, defaultScanCidrs, directedBroadcast, expandScanTargets, FACTORY_SEEDS, inCidr, isEnrichable,
  lanInterfaces, ownAddresses,
} from "./net"

type Info = os.NetworkInterfaceInfo
const v4 = (address: string, prefix: number, internal = false): Info => ({
  address, netmask: "", family: "IPv4", mac: "00:00:00:00:00:00", internal, cidr: `${address}/${prefix}`,
})
const IFACES: NodeJS.Dict<Info[]> = {
  lo: [v4("127.0.0.1", 8, true)],
  enp3s0: [v4("198.51.100.118", 24), { ...v4("fe80::1", 64), family: "IPv6", cidr: "fe80::1/64", scopeid: 2 } as Info],
  wlp2s0: [v4("10.20.0.5", 16)],
  docker0: [v4("172.17.0.1", 16)],
  "br-12ab34": [v4("172.18.0.1", 16)],
  veth9a: [v4("169.254.3.3", 16)],
  tailscale0: [v4("100.68.6.61", 32)],
  virbr0: [v4("192.168.122.1", 24)],
  wg0: [v4("10.99.0.2", 24)],
  ppp0: [v4("10.64.0.9", 31)],
}

describe("LAN interfaces", () => {
  it("keeps non-internal IPv4 with prefix ≤ 30 and skips lo, docker, br-, veth, virbr, tailscale, zt, wg, tun, tap", () => {
    const lan = lanInterfaces(IFACES)
    expect(lan.map((i) => i.name)).toEqual(["enp3s0", "wlp2s0"])
    expect(lan[0]).toMatchObject({ address: "198.51.100.118", prefix: 24, network: "198.51.100.0", broadcast: "198.51.100.255" })
    expect(lan[1]).toMatchObject({ address: "10.20.0.5", prefix: 16, network: "10.20.0.0", broadcast: "10.20.255.255" })
  })

  it("computes the directed broadcast as ip | ~mask", () => {
    expect(directedBroadcast("198.51.100.118", 24)).toBe("198.51.100.255")
    expect(directedBroadcast("10.1.2.3", 22)).toBe("10.1.3.255")
    expect(directedBroadcast("172.16.5.4", 12)).toBe("172.31.255.255")
  })

  it("lists every own IPv4 address, internal included", () => {
    expect(ownAddresses(IFACES)).toEqual(expect.arrayContaining(["127.0.0.1", "198.51.100.118", "172.17.0.1"]))
  })
})

describe("scan targets", () => {
  it("defaults to the /24 of each LAN interface address, even for shorter prefixes", () => {
    expect(defaultScanCidrs(lanInterfaces(IFACES))).toEqual(["198.51.100.0/24", "10.20.0.0/24"])
  })

  it("expands CIDRs excluding the network, the broadcast and our own IPs", () => {
    const { hosts, truncated } = expandScanTargets(["198.51.100.0/24"], { ownIps: ["198.51.100.118"] })
    expect(truncated).toBe(false)
    expect(hosts).toHaveLength(253)
    expect(hosts).not.toContain("198.51.100.0")
    expect(hosts).not.toContain("198.51.100.255")
    expect(hosts).not.toContain("198.51.100.118")
    expect(hosts[0]).toBe("198.51.100.1")
    expect(expandScanTargets(["127.0.0.0/29"], { ownIps: ["127.0.0.1"] }).hosts).toEqual(
      ["127.0.0.2", "127.0.0.3", "127.0.0.4", "127.0.0.5", "127.0.0.6"])
  })

  it("puts the factory fallback IPs first when they fall inside a scanned CIDR", () => {
    expect(FACTORY_SEEDS).toEqual(["192.168.0.123", "192.168.0.200"])
    const { hosts } = expandScanTargets(["192.168.0.0/24"], { ownIps: [] })
    expect(hosts.slice(0, 2)).toEqual(["192.168.0.123", "192.168.0.200"])
    expect(hosts).toHaveLength(254)
    expect(new Set(hosts).size).toBe(254)
    expect(expandScanTargets(["192.168.1.0/24"], { ownIps: [] }).hosts).not.toContain("192.168.0.123")
  })

  it("caps a scan at 2048 hosts and refuses CIDRs wider than /22", () => {
    const r = expandScanTargets(["10.0.0.0/22", "10.0.4.0/22", "10.0.8.0/22"], { ownIps: [] })
    expect(r.hosts).toHaveLength(2048)
    expect(r.truncated).toBe(true)
    expect(() => expandScanTargets(["10.0.0.0/16"], { ownIps: [] })).toThrow()
    expect(expandScanTargets(["10.0.0.7/32"], { ownIps: [] }).hosts).toEqual(["10.0.0.7"])
  })
})

describe("enrichment scope", () => {
  it("derives networks from broadcast targets by their trailing 255 octets", () => {
    expect(broadcastNetworks(["127.255.255.255", "10.1.2.255", "172.16.255.255"])).toEqual(["127.0.0.0/8", "10.1.2.0/24", "172.16.0.0/16"])
  })

  it("allows only IPs inside a LAN subnet or a broadcast target network", () => {
    const lan = lanInterfaces(IFACES)
    expect(isEnrichable("198.51.100.40", lan, null)).toBe(true)
    expect(isEnrichable("10.20.200.1", lan, null)).toBe(true)
    expect(isEnrichable("192.168.0.123", lan, null)).toBe(false)
    expect(isEnrichable("127.0.0.1", lan, null)).toBe(false)
    expect(isEnrichable("127.0.0.2", [], ["127.255.255.255"])).toBe(true)
    expect(isEnrichable("127.0.0.2", [], ["10.1.2.255"])).toBe(false)
    expect(inCidr("10.1.2.9", "10.1.2.0/24")).toBe(true)
    expect(inCidr("10.1.3.9", "10.1.2.0/24")).toBe(false)
  })
})
