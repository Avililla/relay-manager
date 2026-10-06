export interface TimerSlot {
  /** Schedules `fn` after `ms`, replacing any pending one. */
  set(fn: () => void, ms: number): void
  /** Cancels the pending callback, if any (unmount, path change). */
  clear(): void
  readonly pending: boolean
}

/** One pending timeout at a time, cancellable: for hook timers that must not outlive the effect that set them. */
export function createTimerSlot(): TimerSlot {
  let handle: ReturnType<typeof setTimeout> | null = null
  return {
    set(fn, ms) {
      if (handle !== null) clearTimeout(handle)
      handle = setTimeout(() => {
        handle = null
        fn()
      }, ms)
    },
    clear() {
      if (handle !== null) clearTimeout(handle)
      handle = null
    },
    get pending() {
      return handle !== null
    },
  }
}
