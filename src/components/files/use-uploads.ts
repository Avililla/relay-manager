"use client"

import * as React from "react"
import type { UploadItem } from "@/lib/files/upload-engine"
import { uploadEngine } from "@/lib/files/upload-store"

const EMPTY: readonly UploadItem[] = []
const noop = () => () => {}

/** The upload queue of this tab (lives outside React: uploads go on while the user browses). */
export function useUploads(): readonly UploadItem[] {
  const subscribe = React.useCallback((fn: () => void) => uploadEngine().subscribe(fn), [])
  const snapshot = React.useCallback(() => uploadEngine().snapshot(), [])
  return React.useSyncExternalStore(typeof window === "undefined" ? noop : subscribe, snapshot, () => EMPTY)
}

/** Asks before closing or reloading the tab while uploads are running. */
export function useLeaveGuard(active: boolean): void {
  React.useEffect(() => {
    if (!active) return
    const onBefore = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ""
    }
    window.addEventListener("beforeunload", onBefore)
    return () => window.removeEventListener("beforeunload", onBefore)
  }, [active])
}
