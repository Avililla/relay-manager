// Per-operation abort signals: "the service is stopping OR this operation took too long", without leaking.
//
// Do NOT use `AbortSignal.any([life.signal, AbortSignal.timeout(ms)])` with a long-lived parent. Node 22 keeps every
// composite signal reachable from its source signals for as long as the source lives, even after the timeout has
// fired and GC has run: about 1.7 KB per call, i.e. unbounded growth in the 24/7 poll loop (W1-B verification).
// This helper attaches one listener to the parent and removes it (and the deadline timer) when the operation ends.

export interface OpSignal {
  readonly signal: AbortSignal
  /** Detaches from the parent and clears the deadline. Idempotent; call it when the operation settles. */
  dispose(): void
}

/** Aborts when `parent` aborts (same reason) or after `ms` (a `TimeoutError` DOMException, like AbortSignal.timeout). */
export function opSignal(parent: AbortSignal, ms: number): OpSignal {
  const ac = new AbortController()
  if (parent.aborted) {
    ac.abort(parent.reason)
    return { signal: ac.signal, dispose: () => undefined }
  }
  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    clearTimeout(timer)
    parent.removeEventListener("abort", onParent)
  }
  const onParent = () => { dispose(); ac.abort(parent.reason) }
  const timer = setTimeout(() => { dispose(); ac.abort(new DOMException("The operation timed out.", "TimeoutError")) }, ms)
  timer.unref()
  parent.addEventListener("abort", onParent, { once: true })
  return { signal: ac.signal, dispose }
}

/** Runs `fn` with an {@link opSignal} and always disposes it. */
export async function withOpSignal<T>(parent: AbortSignal, ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const op = opSignal(parent, ms)
  try {
    return await fn(op.signal)
  } finally {
    op.dispose()
  }
}
