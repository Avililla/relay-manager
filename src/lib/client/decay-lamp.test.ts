import { describe, expect, it } from "vitest"
import { createDecayLamp, type LampTimers } from "./decay-lamp"

function fakeTimers(): LampTimers & { t: number; advance(ms: number): void; pending(): number } {
  let seq = 0
  const q = new Map<number, { at: number; fn: () => void }>()
  const api = {
    t: 0,
    now: () => api.t,
    set(fn: () => void, ms: number) { const id = ++seq; q.set(id, { at: api.t + ms, fn }); return id },
    clear(h: unknown) { q.delete(h as number) },
    advance(ms: number) {
      const end = api.t + ms
      for (;;) {
        const next = [...q.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!next) break
        q.delete(next[0])
        api.t = next[1].at
        next[1].fn()
      }
      api.t = end
    },
    pending: () => q.size,
  }
  return api
}

describe("RX lamp decay", () => {
  it("a pulse lights the lamp and it goes off after the decay window, with no further updates", () => {
    const timers = fakeTimers()
    const lit: boolean[] = []
    const lamp = createDecayLamp((v) => lit.push(v), { minGapMs: 100, timers })
    lamp.pulse(1000)
    expect(lit).toEqual([true])
    timers.advance(999)
    expect(lit).toEqual([true])
    timers.advance(1)
    expect(lit).toEqual([true, false])
    expect(timers.pending()).toBe(0)
  })

  it("pulses inside the 10 Hz gap do not re-flash but re-arm the decay timer: the lamp still goes off (regression)", () => {
    const timers = fakeTimers()
    const lit: boolean[] = []
    const lamp = createDecayLamp((v) => lit.push(v), { minGapMs: 100, timers })
    lamp.pulse(1000)
    timers.advance(50)
    lamp.pulse(1000)                 // within the gap: no new flash
    timers.advance(30)
    lamp.pulse(1000)
    expect(lit).toEqual([true])
    expect(timers.pending()).toBe(1) // exactly one decay timer, re-armed
    timers.advance(1000)
    expect(lit.at(-1)).toBe(false)
    expect(timers.pending()).toBe(0)
  })

  it("off() (stale) turns it off at once; dispose() (unmount) clears the timer and ignores later pulses", () => {
    const timers = fakeTimers()
    const lit: boolean[] = []
    const lamp = createDecayLamp((v) => lit.push(v), { minGapMs: 100, timers })
    lamp.pulse(1000)
    lamp.off()
    expect(lit).toEqual([true, false])
    expect(timers.pending()).toBe(0)
    timers.advance(200)
    lamp.pulse(1000)
    lamp.dispose()
    expect(timers.pending()).toBe(0)
    const n = lit.length
    lamp.pulse(1000)
    timers.advance(5000)
    expect(lit).toHaveLength(n)
  })
})
