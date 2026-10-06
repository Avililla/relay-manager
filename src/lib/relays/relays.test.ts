import { describe, expect, it } from "vitest"
import { driverCapabilities, effectiveTcpPort } from "./capabilities"
import { modelByName, modelRelayCount } from "./models"
import { clampPulseMs, defaultPulseFor, isPulseEmulated, pulseRange, pulseRangeError } from "./pulse"
import { boardStatusKind, boardStatusLabel, freeChannels, relayStateText } from "./status"

describe("capabilities", () => {
  it("matches §4.8 per driver", () => {
    expect(driverCapabilities("devantech-ds-http")).toEqual({ absoluteSet: false, toggle: "native", pulse: "emulated", pulseMs: { min: 100, max: 60000, step: 100 }, maxRelays: 32 })
    expect(driverCapabilities("devantech-ds-ascii")).toEqual({ absoluteSet: true, toggle: "emulated", pulse: "native", pulseMs: { min: 19, max: 2147483647, step: 1 }, maxRelays: 32 })
    expect(driverCapabilities("devantech-eth", { model: "ETH484" })).toMatchObject({ pulseMs: { min: 100, max: 25500, step: 100 }, maxRelays: 4 })
    expect(driverCapabilities("devantech-eth", { model: "ETH008-B" }).maxRelays).toBe(8)
    expect(driverCapabilities("devantech-eth").maxRelays).toBe(20)
    expect(driverCapabilities("simulated").absoluteSet).toBe(true)
    expect(driverCapabilities("simulated", { options: { sim: { absoluteSet: false } } }).pulse).toBe("emulated")
  })

  it("resolves the default TCP port per driver", () => {
    expect(effectiveTcpPort("devantech-ds-ascii", null)).toBe(17123)
    expect(effectiveTcpPort("devantech-eth", null)).toBe(17494)
    expect(effectiveTcpPort("devantech-eth", 20000)).toBe(20000)
    expect(effectiveTcpPort("devantech-ds-http", null)).toBeNull()
  })

  it("gives the physical relay count per model", () => {
    expect(modelRelayCount("dS378")).toBe(8)
    expect(modelRelayCount("ds2832")).toBe(32)
    expect(modelRelayCount(null)).toBeNull()
    expect(modelByName("ETH8020-B")?.moduleId).toBe(21)
  })
})

describe("pulse", () => {
  const ascii = driverCapabilities("devantech-ds-ascii")
  const http = driverCapabilities("devantech-ds-http")
  const eth = driverCapabilities("devantech-eth", { model: "ETH008" })

  it("intersects the driver range with the action limits (19..60000)", () => {
    expect(pulseRange(ascii)).toEqual({ min: 19, max: 60000, step: 1 })
    expect(pulseRange(eth)).toEqual({ min: 100, max: 25500, step: 100 })
    expect(pulseRange({ ...ascii, pulse: "none", pulseMs: null })).toBeNull()
  })

  it("defaults to defaultPulseMs ?? clamp(500, min, max), snapped to the step", () => {
    expect(defaultPulseFor(null, ascii)).toBe(500)
    expect(defaultPulseFor(250, http)).toBe(300)
    expect(defaultPulseFor(90000, eth)).toBe(25500)
    expect(defaultPulseFor(20, eth)).toBe(100)
    expect(clampPulseMs(1234, ascii)).toBe(1234)
    expect(clampPulseMs(Number.NaN, ascii)).toBeNull()
  })

  it("explains out-of-range values in Spanish and flags emulated pulses", () => {
    expect(pulseRangeError(50, http)).toBe("La duración del pulso debe estar entre 100 y 60000 ms")
    expect(pulseRangeError(500, http)).toBeNull()
    expect(pulseRangeError(10.5, ascii)).not.toBeNull()
    expect(isPulseEmulated(http)).toBe(true)
    expect(isPulseEmulated(ascii)).toBe(false)
  })

  it("rejects a duration off the driver step (ETH would send round(150/100)·100 = 200 ms)", () => {
    const stepMsg = "La duración del pulso debe estar entre 100 y 25500 ms, en pasos de 100 ms"
    expect(pulseRangeError(150, eth)).toBe(stepMsg)
    expect(pulseRangeError(25450, eth)).toBe(stepMsg)
    expect(pulseRangeError(200, eth)).toBeNull()
    expect(pulseRangeError(25500, eth)).toBeNull()
    expect(pulseRangeError(350, http)).toBe("La duración del pulso debe estar entre 100 y 60000 ms, en pasos de 100 ms")
    expect(pulseRangeError(1234, ascii)).toBeNull()
    // Every clamped value passes the server check.
    for (const ms of [19, 99, 149, 150, 151, 999, 25449, 70000]) {
      for (const caps of [ascii, http, eth]) {
        const v = clampPulseMs(ms, caps)
        expect(v === null ? null : pulseRangeError(v, caps)).toBeNull()
      }
    }
  })

  it("keeps the effective range on the driver grid when the action limits cut it", () => {
    const odd = { ...eth, pulseMs: { min: 5, max: 70_005, step: 10 } }
    expect(pulseRange(odd)).toEqual({ min: 25, max: 59_995, step: 10 })
    expect(pulseRangeError(25, odd)).toBeNull()
    expect(pulseRangeError(30, odd)).not.toBeNull()
    expect(clampPulseMs(19, odd)).toBe(25)
    expect(clampPulseMs(60_000, odd)).toBe(59_995)
  })
})

describe("status labels", () => {
  const rt = (online: boolean | null, lastSeenAt: string | null = null) => ({ online, lastSeenAt })
  it("never relies on colour: ON / OFF / ? and board states in words", () => {
    expect([true, false, null].map(relayStateText)).toEqual(["ON", "OFF", "?"])
    expect(boardStatusKind({ enabled: false, runtime: rt(true) })).toBe("disabled")
    expect(boardStatusLabel({ enabled: true, runtime: rt(true) }, (s) => s)).toBe("Conectada")
    expect(boardStatusLabel({ enabled: true, runtime: rt(null) }, (s) => s)).toBe("Sin leer todavía")
    expect(boardStatusLabel({ enabled: true, runtime: rt(false, "2026-09-23T13:02:00.000Z") }, () => "13:02")).toBe("Sin respuesta desde 13:02")
    expect(boardStatusLabel({ enabled: true, runtime: rt(false) }, (s) => s)).toBe("Sin respuesta")
    expect(freeChannels(4, [2, 4])).toEqual([1, 3])
  })
})
