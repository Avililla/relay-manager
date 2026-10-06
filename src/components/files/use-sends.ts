"use client"

import * as React from "react"
import type { SendJobDTO } from "@/lib/contracts/files"
import { sendStore } from "@/lib/files/send-store"
import { useServerEvents } from "@/hooks/use-server-events"

const EMPTY: readonly SendJobDTO[] = []
const noop = () => () => {}

/** The user's «Envíos» (synced on mount and after each reconnection; live with `files.send`). */
export function useSends(): readonly SendJobDTO[] {
  const subscribe = React.useCallback((fn: () => void) => sendStore().subscribe(fn), [])
  const snapshot = React.useCallback(() => sendStore().snapshot(), [])
  React.useEffect(() => { void sendStore().sync() }, [])
  useServerEvents(["files.send", "hello"], (e) => {
    if (e.type === "files.send") sendStore().apply(e.job)
    else void sendStore().sync()
  })
  return React.useSyncExternalStore(typeof window === "undefined" ? noop : subscribe, snapshot, () => EMPTY)
}
