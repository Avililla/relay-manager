"use client"

import * as React from "react"
import type { CopyJobDTO } from "@/lib/contracts/files"
import { copyStore } from "@/lib/files/copy-store"
import { useServerEvents } from "@/hooks/use-server-events"

const EMPTY: readonly CopyJobDTO[] = []
const noop = () => () => {}

/** The administrator's «Copias» (synced on mount and after each reconnection; live with `files.copy`). */
export function useCopies(enabled: boolean): readonly CopyJobDTO[] {
  const subscribe = React.useCallback((fn: () => void) => copyStore().subscribe(fn), [])
  const snapshot = React.useCallback(() => copyStore().snapshot(), [])
  React.useEffect(() => { if (enabled) void copyStore().sync() }, [enabled])
  useServerEvents(["files.copy", "hello"], (e) => {
    if (!enabled) return
    if (e.type === "files.copy") copyStore().apply(e.job)
    else void copyStore().sync()
  })
  const jobs = React.useSyncExternalStore(typeof window === "undefined" ? noop : subscribe, snapshot, () => EMPTY)
  return enabled ? jobs : EMPTY
}
