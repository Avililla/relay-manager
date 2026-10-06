import { describe, expect, it } from "vitest"
import { allocatePorts, parsePortRange, portIssue } from "./ports"

const range = { from: 3201, to: 3230 }

describe("parsePortRange", () => {
  it("parses a range and a single port", () => {
    expect(parsePortRange("3201-3230")).toEqual({ from: 3201, to: 3230 })
    expect(parsePortRange(" 4000 - 4001 ")).toEqual({ from: 4000, to: 4001 })
    expect(parsePortRange("3201")).toEqual({ from: 3201, to: 3201 })
  })
  it("rejects reversed, privileged, out of range, huge and malformed ranges", () => {
    for (const bad of ["3230-3201", "80-90", "65000-70000", "1024-9000", "abc", "3201-", "-3201", "3201-3230-3240", ""]) {
      expect(parsePortRange(bad), bad).toBeNull()
    }
  })
})

describe("portIssue", () => {
  it("accepts a free port in the range", () => {
    expect(portIssue(3205, { range, httpPort: 3200, used: new Set([3201]) })).toBeNull()
  })
  it("reports out of range, the web port and a taken port", () => {
    expect(portIssue(3300, { range, httpPort: 3200, used: new Set() })).toBe("out-of-range")
    expect(portIssue(3200, { range: { from: 3200, to: 3230 }, httpPort: 3200, used: new Set() })).toBe("http-port")
    expect(portIssue(3201, { range, httpPort: 3200, used: new Set([3201]) })).toBe("taken")
  })
})

describe("allocatePorts", () => {
  it("gives the lowest free ports in order, skipping used ones and the web port", () => {
    const r = allocatePorts([null, null, null], { range: { from: 3200, to: 3230 }, httpPort: 3200, used: [3201, 3203] })
    expect(r).toEqual({ ok: true, ports: [3202, 3204, 3205] })
  })
  it("keeps fixed ports and never gives them to automatic rows", () => {
    const r = allocatePorts([null, 3201, null], { range, httpPort: 3200, used: [] })
    expect(r).toEqual({ ok: true, ports: [3202, 3201, 3203] })
  })
  it("reports the first row that gets no port when the range is exhausted", () => {
    const r = allocatePorts([null, null, null], { range: { from: 3201, to: 3202 }, httpPort: 3200, used: [] })
    expect(r).toEqual({ ok: false, index: 2 })
  })
  it("is deterministic, so the wizard preview matches what the server gives", () => {
    const opts = { range, httpPort: 3200, used: [3210, 3202] }
    expect(allocatePorts([null, null, null, null, null], opts)).toEqual(allocatePorts([null, null, null, null, null], opts))
  })
})
