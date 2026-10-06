import { describe, expect, it } from "vitest"
import { formatInteger, parseInteger } from "./format"

describe("integers for NumberStepper (es-ES digit grouping)", () => {
  it("groups thousands like the help texts", () => {
    expect(formatInteger(10000)).toBe("10.000")
    expect(formatInteger(1000)).toBe("1.000")
    expect(formatInteger(512)).toBe("512")
    expect(formatInteger(-2500)).toBe("-2.500")
  })
  it("reads back grouped, spaced or plain input", () => {
    expect(parseInteger("10.000")).toBe(10000)
    expect(parseInteger("10 000")).toBe(10000)
    expect(parseInteger("10 000")).toBe(10000)
    expect(parseInteger("2500")).toBe(2500)
    expect(parseInteger("12,6")).toBe(12.6)
    expect(parseInteger("")).toBeNull()
    expect(parseInteger("abc")).toBeNull()
  })
})
