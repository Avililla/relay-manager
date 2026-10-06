import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createTimerSlot } from "./timer-slot"

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

// useConsoleSocket keeps its 4011 ("refresh and retry") timer in one slot and clears it on unmount or path change.
describe("timer slot", () => {
  it("runs the callback once after the delay", () => {
    const slot = createTimerSlot()
    const fn = vi.fn()
    slot.set(fn, 1000)
    expect(slot.pending).toBe(true)
    vi.advanceTimersByTime(1000)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(slot.pending).toBe(false)
  })

  it("clear() (unmount) cancels the pending retry", () => {
    const slot = createTimerSlot()
    const fn = vi.fn()
    slot.set(fn, 1000)
    slot.clear()
    vi.advanceTimersByTime(5000)
    expect(fn).not.toHaveBeenCalled()
    expect(slot.pending).toBe(false)
  })

  it("a new set() replaces the pending one (only the last runs)", () => {
    const slot = createTimerSlot()
    const a = vi.fn()
    const b = vi.fn()
    slot.set(a, 1000)
    slot.set(b, 1000)
    vi.advanceTimersByTime(1000)
    expect(a).not.toHaveBeenCalled()
    expect(b).toHaveBeenCalledTimes(1)
  })
})
