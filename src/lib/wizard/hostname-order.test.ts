import { describe, expect, it } from "vitest"
import { reorderByHostname } from "./hostname-order"

const UART0 = { hostnameRegex: "uart0" }
const UART1 = { hostnameRegex: "uart1" }
const NONE = {}

describe("reorderByHostname", () => {
  it("swaps two ports whose hostnames match the other slot", () => {
    const r = reorderByHostname([UART0, UART1], ["p1", "p2"], { p1: "equipo-a-01-uart1", p2: "equipo-a-01-uart0" })
    expect(r).toEqual({ assignments: ["p2", "p1"], matched: 2, changed: true })
  })

  it("reports no change when the order already matches", () => {
    const r = reorderByHostname([UART0, UART1], ["p1", "p2"], { p1: "equipo-a-01-uart0", p2: "equipo-a-01-uart1" })
    expect(r).toEqual({ assignments: ["p1", "p2"], matched: 2, changed: false })
  })

  it("returns null when no slot matches any hostname", () => {
    expect(reorderByHostname([UART0, UART1], ["p1", "p2"], { p1: "equipo-c-01", p2: null })).toBeNull()
    expect(reorderByHostname([NONE, NONE], ["p1", "p2"], { p1: "uart1", p2: "uart0" })).toBeNull()
    expect(reorderByHostname([UART0, UART1], ["p1", "p2"], {})).toBeNull()
  })

  it("matches case-insensitively", () => {
    const r = reorderByHostname([UART0, UART1], ["p1", "p2"], { p1: "EQUIPO-A-01-UART1", p2: "EQUIPO-A-01-UART0" })
    expect(r?.assignments).toEqual(["p2", "p1"])
  })

  it("pulls in an identified port that was not assigned yet", () => {
    const r = reorderByHostname([UART0, UART1], ["p1", "p2"], { p1: null, p2: "x-uart1", p3: "x-uart0" })
    expect(r).toEqual({ assignments: ["p3", "p2"], matched: 2, changed: true })
  })

  it("fills slots that start unassigned", () => {
    const r = reorderByHostname([UART0, UART1], [null, null], { p1: "u-uart1", p2: "u-uart0" })
    expect(r).toEqual({ assignments: ["p2", "p1"], matched: 2, changed: true })
  })

  it("keeps the port of a slot without a match when nobody else takes it", () => {
    const r = reorderByHostname([UART0, UART1, NONE], ["p1", "p2", "p3"], { p1: "uart1", p2: "uart0", p3: null })
    expect(r?.assignments).toEqual(["p2", "p1", "p3"])
  })

  it("gives a displaced port to a slot whose port was taken", () => {
    const r = reorderByHostname([{ hostnameRegex: "alpha" }, NONE], ["p1", "p2"], { p2: "box-alpha" })
    expect(r).toEqual({ assignments: ["p2", "p1"], matched: 1, changed: true })
  })

  it("leaves a slot empty when no displaced port is left", () => {
    const r = reorderByHostname([{ hostnameRegex: "alpha" }, NONE], [null, "p2"], { p2: "box-alpha" })
    expect(r?.assignments).toEqual(["p2", null])
  })

  it("serves the most constrained slot first when one hostname matches several patterns", () => {
    const r = reorderByHostname([{ hostnameRegex: "sec" }, { hostnameRegex: "sec[-_]?if" }], ["p1", "p2"], { p1: "box-sec-if", p2: "box-sec" })
    expect(r?.assignments).toEqual(["p2", "p1"])
  })

  it("never assigns one port to two slots", () => {
    const r = reorderByHostname([UART1, UART1], ["p1", "p2"], { p1: "a-uart1", p2: null })
    expect(r?.assignments).toEqual(["p1", "p2"])
    const keys = r?.assignments.filter(Boolean) ?? []
    expect(new Set(keys).size).toBe(keys.length)
  })

  it("ignores invalid, empty and missing expressions without throwing", () => {
    expect(reorderByHostname([{ hostnameRegex: "(" }, { hostnameRegex: "" }, { hostnameRegex: null }], ["p1", "p2", "p3"], { p1: "(", p2: "x", p3: "y" })).toBeNull()
  })

  it("does not change the input arrays", () => {
    const current = ["p1", "p2"]
    reorderByHostname([UART0, UART1], current, { p1: "uart1", p2: "uart0" })
    expect(current).toEqual(["p1", "p2"])
  })
})
