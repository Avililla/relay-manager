import { describe, expect, it } from "vitest"
import { addClockSample, clockOffset, countdownView, remainingMs } from "./countdown"

const T = (iso: string) => Date.parse(iso)

describe("server clock offset", () => {
  it("is the median of the last 5 samples", () => {
    let samples: number[] = []
    // server - client offsets: +1000, +1200, +900, +5000 (outlier), +1100, +1050
    const pairs: Array<[string, number]> = [
      ["2026-09-23T10:00:01.000Z", T("2026-09-23T10:00:00.000Z")],
      ["2026-09-23T10:00:01.200Z", T("2026-09-23T10:00:00.000Z")],
      ["2026-09-23T10:00:00.900Z", T("2026-09-23T10:00:00.000Z")],
      ["2026-09-23T10:00:05.000Z", T("2026-09-23T10:00:00.000Z")],
      ["2026-09-23T10:00:01.100Z", T("2026-09-23T10:00:00.000Z")],
    ]
    for (const [server, client] of pairs) samples = addClockSample(samples, server, client)
    expect(samples).toHaveLength(5)
    expect(clockOffset(samples)).toBe(1100)
    samples = addClockSample(samples, "2026-09-23T10:00:01.050Z", T("2026-09-23T10:00:00.000Z"))
    expect(samples).toHaveLength(5)               // the oldest sample (+1000) was dropped
    expect(clockOffset(samples)).toBe(1100)       // [1200, 900, 5000, 1100, 1050] → 1100
  })

  it("is 0 without samples and ignores invalid dates", () => {
    expect(clockOffset([])).toBe(0)
    expect(addClockSample([], "not a date", 0)).toEqual([])
  })

  it("an even count uses the mean of the two middle samples", () => {
    expect(clockOffset([100, 300])).toBe(200)
  })
})

describe("remainingMs", () => {
  it("uses the server offset", () => {
    const expiresAt = "2026-09-23T10:24:13.000Z"
    const client = T("2026-09-23T09:59:00.000Z")
    // The client clock is 60 s behind the server: the server says it is 10:00:00.
    expect(remainingMs(expiresAt, client, 60_000)).toBe(24 * 60_000 + 13_000)
  })
})

describe("countdownView", () => {
  const expiresAt = "2026-09-23T11:42:00.000Z"

  it("renders the absolute time before mount (server render and hydration)", () => {
    const v = countdownView({ expiresAt, mounted: false, clientNow: 0, offset: 0, timeZone: "Europe/Madrid" })
    expect(v).toEqual({ kind: "absolute", text: "hasta 13:42" })
  })

  it("renders m:ss from the server clock after mount", () => {
    const client = T("2026-09-23T11:17:47.000Z") - 5000   // client 5 s behind
    const v = countdownView({ expiresAt, mounted: true, clientNow: client, offset: 5000 })
    expect(v).toMatchObject({ kind: "remaining", text: "24:13", remainingMs: 24 * 60_000 + 13_000 })
  })

  it("rounds up partial seconds so the chip never shows 0:00 early", () => {
    const v = countdownView({ expiresAt, mounted: true, clientNow: T(expiresAt) - 400, offset: 0 })
    expect(v).toMatchObject({ kind: "remaining", text: "0:01" })
  })

  it("never shows more than the reservation timeout: a 30 min reservation reads 30:00 right after reserving, not 30:01", () => {
    // Reserved at 10:00:00.700 (server ms), ticking clock floored to the second (useServerNow).
    const end = "2026-09-23T10:30:00.700Z"
    expect(countdownView({ expiresAt: end, mounted: true, clientNow: T("2026-09-23T10:00:00.000Z"), offset: 0 })).toMatchObject({ text: "30:00" })
    expect(countdownView({ expiresAt: end, mounted: true, clientNow: T("2026-09-23T10:00:01.000Z"), offset: 0 })).toMatchObject({ text: "29:59" })
  })

  it("shows «Expirando…» at or below zero", () => {
    expect(countdownView({ expiresAt, mounted: true, clientNow: T(expiresAt), offset: 0 })).toEqual({ kind: "expiring", text: "Expirando…" })
    expect(countdownView({ expiresAt, mounted: true, clientNow: T(expiresAt) + 9000, offset: 0 })).toEqual({ kind: "expiring", text: "Expirando…" })
  })

  it("an unparseable expiry falls back to «Expirando…»", () => {
    expect(countdownView({ expiresAt: "x", mounted: true, clientNow: 0, offset: 0 }).kind).toBe("expiring")
  })
})
