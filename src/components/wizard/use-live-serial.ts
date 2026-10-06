"use client"

import * as React from "react"
import { useServerEvents } from "@/components/providers/events-provider"
import { useLiveState } from "@/hooks/use-live-state"
import type { ServerEvent, ServerEventType } from "@/lib/contracts/events"
import type { SerialSnapshotDTO } from "@/lib/contracts/serial"
import { allPorts } from "@/lib/wizard/ports"

const SERIAL_EVENTS: readonly ServerEventType[] = ["serial.changed"]
const NEW_FOR_MS = 10_000

function reduceSerial(s: SerialSnapshotDTO, e: ServerEvent): SerialSnapshotDTO {
  return e.type === "serial.changed" ? e.snapshot : s
}

const keysOf = (s: SerialSnapshotDTO) => new Set(allPorts(s).map((p) => p.stableKey))

/**
 * The serial snapshot kept live by `serial.changed` (admins audience), plus `isNew(stableKey)` for ports that
 * appeared while the page is open (hot-plug highlight, `animate-new-row`, for 10 s).
 */
export function useLiveSerial(initial: SerialSnapshotDTO): { snapshot: SerialSnapshotDTO; isNew: (stableKey: string) => boolean } {
  const snapshot = useLiveState(initial, SERIAL_EVENTS, reduceSerial)
  const previous = React.useRef<Set<string> | null>(null)
  const [fresh, setFresh] = React.useState<ReadonlySet<string>>(() => new Set())
  useServerEvents(SERIAL_EVENTS, (e) => {
    if (e.type !== "serial.changed") return
    const before = previous.current ?? keysOf(initial)
    const now = keysOf(e.snapshot)
    previous.current = now
    const added = [...now].filter((k) => !before.has(k))
    if (!added.length) return
    setFresh((f) => new Set([...f, ...added]))
    window.setTimeout(() => setFresh((f) => new Set([...f].filter((k) => !added.includes(k)))), NEW_FOR_MS)
  })
  const isNew = React.useCallback((k: string) => fresh.has(k), [fresh])
  return { snapshot, isNew }
}
