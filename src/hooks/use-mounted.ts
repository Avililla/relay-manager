"use client"

import { useSyncExternalStore } from "react"

const noop = () => () => {}

/** False during the server render and hydration, true afterwards (no effect, no extra state). */
export function useMounted(): boolean {
  return useSyncExternalStore(noop, () => true, () => false)
}
