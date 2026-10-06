"use client"

import { useCallback, useSyncExternalStore } from "react"

/** Tracks a media query; `serverValue` is used for the server render and hydration. */
export function useMediaQuery(query: string, serverValue = false): boolean {
  const subscribe = useCallback((onChange: () => void) => {
    const mq = window.matchMedia(query)
    mq.addEventListener("change", onChange)
    return () => mq.removeEventListener("change", onChange)
  }, [query])
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches, () => serverValue)
}
