import { describe, expect, it } from "vitest"
import { formatIPv4, isIPv4, overlaps, parseCidr, parseIPv4, subnetOf } from "./ipv4"

describe("ipv4", () => {
  it("parses and formats dotted quads", () => {
    expect(parseIPv4("192.168.1.10")).toBe(0xc0a8010a)
    expect(formatIPv4(0xc0a8010a)).toBe("192.168.1.10")
    expect(parseIPv4("255.255.255.255")).toBe(0xffffffff)
    for (const bad of ["", "1.2.3", "1.2.3.4.5", "256.1.1.1", "01.2.3.4", "1.2.3.-1", " 1.2.3.4", "a.b.c.d"]) expect(parseIPv4(bad)).toBeNull()
    expect(isIPv4("10.0.0.1")).toBe(true)
  })
  it("parses CIDR with network and broadcast", () => {
    expect(parseCidr("192.168.0.250/24")).toEqual({ ip: "192.168.0.250", prefix: 24, network: "192.168.0.0", broadcast: "192.168.0.255" })
    expect(parseCidr("10.1.2.3/8")?.network).toBe("10.0.0.0")
    expect(parseCidr("10.1.2.3/33")).toBeNull()
    expect(parseCidr("10.1.2.3")).toBeNull()
    expect(subnetOf("192.168.1.10", 24)).toBe("192.168.1.0/24")
  })
  it("detects overlapping subnets", () => {
    expect(overlaps("192.168.1.0/24", "192.168.0.0/16")).toBe(true)
    expect(overlaps("192.168.1.0/24", "192.168.0.0/24")).toBe(false)
    expect(overlaps("198.51.100.0/24", "198.51.100.128/25")).toBe(true)
  })
})
