export interface LampTimers {
  set(fn: () => void, ms: number): unknown
  clear(handle: unknown): void
  now(): number
}

const realTimers: LampTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  now: () => performance.now(),
}

export interface DecayLamp {
  /** Data arrived: flash (at most once per `minGapMs`) and (re)arm the decay, so the lamp goes off `litMs` later. */
  pulse(litMs: number): void
  /** Off now (stale connection). */
  off(): void
  /** Unmount: clears the timer; later calls do nothing. */
  dispose(): void
}

/**
 * The RX lamp's timing (§8.5), apart from React: exactly one decay timer, re-armed by every pulse, so the lamp always
 * goes off after the decay window even when a pulse is rate-limited or no more data arrives.
 */
export function createDecayLamp(setLit: (lit: boolean) => void, opts: { minGapMs: number; timers?: LampTimers }): DecayLamp {
  const timers = opts.timers ?? realTimers
  let timer: unknown = null
  let lastFlash = Number.NEGATIVE_INFINITY
  let disposed = false
  const disarm = () => {
    if (timer !== null) timers.clear(timer)
    timer = null
  }
  return {
    pulse(litMs) {
      if (disposed) return
      const t = timers.now()
      if (t - lastFlash >= opts.minGapMs) {
        lastFlash = t
        setLit(true)
      }
      disarm()
      timer = timers.set(() => {
        timer = null
        if (!disposed) setLit(false)
      }, litMs)
    },
    off() {
      if (disposed) return
      disarm()
      setLit(false)
    },
    dispose() {
      disposed = true
      disarm()
    },
  }
}
