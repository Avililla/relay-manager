"use client"

import * as React from "react"
import type { ExportInfoDTO, ExportJobDTO } from "@/lib/contracts/files"
import { exportStore } from "@/lib/files/export-store"
import { useServerEvents } from "@/hooks/use-server-events"

const EMPTY: readonly ExportJobDTO[] = []
const noop = () => () => {}

/**
 * «Descargas» (the profile's download script) (the user's own; every one for administrators): synced on mount and after each
 * reconnection, live with `files.export` (job changes plus the log lines appended since the previous event).
 */
export function useExports(enabled: boolean): { jobs: readonly ExportJobDTO[]; info: ExportInfoDTO | null } {
  const subscribe = React.useCallback((fn: () => void) => exportStore().subscribe(fn), [])
  const snapshot = React.useCallback(() => exportStore().snapshot(), [])
  React.useEffect(() => { if (enabled) void exportStore().sync() }, [enabled])
  useServerEvents(["files.export", "hello"], (e) => {
    if (!enabled) return
    if (e.type === "files.export") exportStore().apply(e.job, e.lines)
    else void exportStore().sync()
  })
  const jobs = React.useSyncExternalStore(typeof window === "undefined" ? noop : subscribe, snapshot, () => EMPTY)
  return { jobs: enabled ? jobs : EMPTY, info: enabled ? exportStore().info() : null }
}
