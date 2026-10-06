"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { useServerEvents } from "@/components/providers/events-provider"
import type { ServerEvent, ServerEventType } from "@/lib/contracts/events"

/**
 * Re-renders the page on the server (debounced `router.refresh()`) when a matching event arrives: port
 * assignments and board channels change when any equipment is saved, and `serial.changed` does not carry those.
 * Drafts survive: they live in client state, and the live hooks reset only their own server values.
 */
export function useRefreshOn(types: readonly ServerEventType[], when: (e: ServerEvent) => boolean = () => true, delayMs = 300): void {
  const router = useRouter()
  const timer = React.useRef<number | null>(null)
  React.useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current)
  }, [])
  useServerEvents(types, (e) => {
    if (!when(e)) return
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      timer.current = null
      router.refresh()
    }, delayMs)
  })
}
