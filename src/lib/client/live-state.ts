// Pure core of useLiveState (§8.8): server value + SSE deltas, reset on every new RSC payload.
import type { ServerEvent, ServerEventType } from "@/lib/contracts/events"

export interface LiveCell<T> {
  /** The server value this cell was derived from (compared by identity). */
  base: T
  /** The server value with the live events applied. */
  value: T
}

export function initLiveCell<T>(serverValue: T): LiveCell<T> {
  return { base: serverValue, value: serverValue }
}

/** Resets when the server value changes identity (a new RSC payload after router.refresh()). */
export function syncLiveCell<T>(cell: LiveCell<T>, serverValue: T): LiveCell<T> {
  return Object.is(cell.base, serverValue) ? cell : initLiveCell(serverValue)
}

export function applyLiveEvent<T>(
  cell: LiveCell<T>,
  event: ServerEvent,
  types: readonly ServerEventType[],
  reduce: (s: T, e: ServerEvent) => T,
): LiveCell<T> {
  if (!types.includes(event.type)) return cell
  const next = reduce(cell.value, event)
  return Object.is(next, cell.value) ? cell : { base: cell.base, value: next }
}
