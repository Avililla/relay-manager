"use client"

import { useState } from "react"
import type { ServerEvent, ServerEventType } from "@/lib/contracts/events"
import { applyLiveEvent, initLiveCell, syncLiveCell } from "@/lib/client/live-state"
import { useServerEvents } from "@/components/providers/events-provider"

/**
 * Server value + live SSE deltas (§8.8). Every live component uses this, never `useState(initialProp)`:
 * when `serverValue` changes identity (a new RSC payload after router.refresh()), the state resets to it, then the
 * matching events are applied through `reduce`. `types` should be a constant list.
 */
export function useLiveState<T>(serverValue: T, types: readonly ServerEventType[], reduce: (s: T, e: ServerEvent) => T): T {
  const [cell, setCell] = useState(() => initLiveCell(serverValue))
  const synced = syncLiveCell(cell, serverValue)
  if (synced !== cell) setCell(synced) // adjust state while rendering: React re-renders before committing
  useServerEvents(types, (e) => {
    setCell((c) => applyLiveEvent(c, e, types, reduce))
  })
  return synced.value
}
