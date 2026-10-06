// Set-then-verify (§4.9 set step 3): after the write, up to N reads, `intervalMs` apart, until the channel reads `on`.
import type { BoardRef, RelayDriver } from "./types"

export interface VerifyOptions {
  attempts: number
  intervalMs: number
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason instanceof Error ? signal.reason : new Error("aborted")); return }
    const t = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve() }, ms)
    const onAbort = () => { clearTimeout(t); reject(signal?.reason instanceof Error ? signal.reason : new Error("aborted")) }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

/**
 * Writes, then reads back. The first read waits `intervalMs`, so a relay configured as a short pulse on the board has
 * already dropped back. Returns the last states read and whether the channel matched.
 */
export async function setAndVerify(
  driver: RelayDriver, board: BoardRef, channel: number, on: boolean, signal: AbortSignal, opts: VerifyOptions,
): Promise<{ states: boolean[]; verified: boolean }> {
  const sleep = opts.sleep ?? abortableSleep
  await driver.setRelay(board, channel, on, signal)
  let states: boolean[] = []
  for (let i = 0; i < Math.max(1, opts.attempts); i++) {
    await sleep(opts.intervalMs, signal)
    states = await driver.readState(board, signal)
    if (states[channel - 1] === on) return { states, verified: true }
  }
  return { states, verified: false }
}
