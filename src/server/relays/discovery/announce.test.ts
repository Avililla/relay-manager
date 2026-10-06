import { describe, expect, it } from "vitest"
import { DISCOVERY_REQUEST, parseAnnouncement } from "./announce"

const CRLF = [0x0d, 0x0a]
function harmony(o: {
  mac?: number[]; macName?: string; hostname?: string; ip?: number[]; moduleId?: number; port?: number; simHttp?: number; extra?: number[]
}): Buffer {
  const b: number[] = []
  if (o.mac) b.push(0x02, ...o.mac, ...CRLF)
  if (o.macName !== undefined) b.push(0x03, ...Buffer.from(o.macName, "latin1"), ...CRLF)
  if (o.hostname !== undefined) b.push(0x04, ...Buffer.from(o.hostname, "latin1"), ...CRLF)
  if (o.ip) b.push(0x05, ...o.ip, ...CRLF)
  b.push(...CRLF) // "user start" separator
  if (o.moduleId !== undefined) b.push(0x40, o.moduleId, ...CRLF)
  if (o.port !== undefined) b.push(0x41, (o.port >> 8) & 0xff, o.port & 0xff, ...CRLF)
  if (o.simHttp !== undefined) b.push(0x7f, (o.simHttp >> 8) & 0xff, o.simHttp & 0xff, ...CRLF)
  if (o.extra) b.push(...o.extra)
  return Buffer.from(b)
}

describe("discovery request", () => {
  it("is the 30-byte Microchip Discoverer payload", () => {
    expect(DISCOVERY_REQUEST.length).toBe(30)
    expect(DISCOVERY_REQUEST.toString("latin1")).toBe("Discovery: Who is out there?\0\n")
  })
})

describe("parseAnnouncement (Harmony TLV)", () => {
  it("parses MAC, names, module id and port; the ip is the datagram source", () => {
    const a = parseAnnouncement(harmony({ mac: [0x00, 0x04, 0xa3, 0x11, 0x22, 0x33], macName: "ETH", hostname: "dS378",
      ip: [198, 51, 100, 40], moduleId: 35, port: 17123 }), "198.51.100.40", { simulate: false })
    expect(a).toMatchObject({
      format: "harmony", ip: "198.51.100.40", mac: "00:04:a3:11:22:33", macName: "ETH", hostname: "dS378",
      moduleId: 35, model: "dS378", tcpPort: 17123, httpPort: null, announcedIp: "198.51.100.40",
    })
    expect(a?.hints).toContain("OUI Microchip")
    expect(a?.hints.some((h) => h.startsWith("La placa anuncia otra IP"))).toBe(false)
  })

  it("keeps fixed-length fields intact when the MAC and IP contain CR/LF bytes", () => {
    const a = parseAnnouncement(harmony({ mac: [0x00, 0x1e, 0xc0, 0x0d, 0x0a, 0x0d], hostname: "eth008",
      ip: [10, 13, 10, 13], moduleId: 19, port: 0x0d0a }), "10.13.10.13", { simulate: false })
    expect(a).toMatchObject({ mac: "00:1e:c0:0d:0a:0d", hostname: "eth008", announcedIp: "10.13.10.13", moduleId: 19,
      model: "ETH008", tcpPort: 0x0d0a })
  })

  it("never takes the IP from the TLV: a different 0x05 value only adds a hint", () => {
    const a = parseAnnouncement(harmony({ mac: [0xd8, 0x80, 0x39, 1, 2, 3], ip: [127, 0, 0, 1], moduleId: 35 }), "192.168.1.50", { simulate: false })
    expect(a?.ip).toBe("192.168.1.50")
    expect(a?.announcedIp).toBe("127.0.0.1")
    expect(a?.hints).toContain("La placa anuncia otra IP: 127.0.0.1")
  })

  it("honours the simulator-only 0x7F http port only when simulate is on", () => {
    const buf = harmony({ mac: [0, 4, 0xa3, 0, 0, 1], moduleId: 35, port: 17123, simHttp: 18080 })
    expect(parseAnnouncement(buf, "127.0.0.2", { simulate: true })?.httpPort).toBe(18080)
    expect(parseAnnouncement(buf, "127.0.0.2", { simulate: false })?.httpPort).toBeNull()
  })

  it("skips unknown types up to the next CRLF and survives IPv6 fields", () => {
    const buf = harmony({ mac: [0, 4, 0xa3, 0, 0, 2], hostname: "x", extra: [0x55, 0x41, 0x42, ...CRLF, 0x06, ...new Array(16).fill(0x0a), ...CRLF, 0x40, 20, ...CRLF] })
    const a = parseAnnouncement(buf, "10.0.0.2", { simulate: false })
    expect(a).toMatchObject({ mac: "00:04:a3:00:00:02", hostname: "x", moduleId: 20, model: "ETH484" })
  })

  it("sanitises text fields to printable ASCII and caps them at 64 characters", () => {
    const a = parseAnnouncement(harmony({ mac: [1, 2, 3, 4, 5, 6], hostname: `bad\x1b[31m\x07name${"x".repeat(100)}` }), "10.0.0.3", { simulate: false })
    expect(a?.hostname).toMatch(/^bad\[31mnamex+$/)
    expect(a?.hostname?.length).toBe(64)
    expect(a?.hints).not.toContain("OUI Microchip")
  })
})

describe("parseAnnouncement (MLA text)", () => {
  it("parses NetBIOS name, MAC and message; the ip is the datagram source", () => {
    const buf = Buffer.from("ETH008         \r\n00-04-A3-AA-BB-CC\r\nDHCP/Power event occurred", "latin1")
    expect(parseAnnouncement(buf, "198.51.100.77", { simulate: false })).toMatchObject({
      format: "mla", ip: "198.51.100.77", hostname: "ETH008", mac: "00:04:a3:aa:bb:cc", message: "DHCP/Power event occurred",
      moduleId: null, announcedIp: null,
    })
  })
})

describe("packets to drop", () => {
  it("drops requests (first byte 'D'), short packets and garbage", () => {
    expect(parseAnnouncement(DISCOVERY_REQUEST, "10.0.0.1", { simulate: false })).toBeNull()
    expect(parseAnnouncement(Buffer.from("Discovery? another finder"), "10.0.0.1", { simulate: false })).toBeNull()
    expect(parseAnnouncement(Buffer.from([0x02, 1, 2, 3]), "10.0.0.1", { simulate: false })).toBeNull()
    expect(parseAnnouncement(Buffer.from("just some text\r\nwithout a mac\r\n"), "10.0.0.1", { simulate: false })).toBeNull()
  })
})
