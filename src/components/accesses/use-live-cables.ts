"use client"

import { useLiveState } from "@/hooks/use-live-state"
import type { CableLabelDTO, JtagSnapshotDTO } from "@/lib/contracts/accesses"
import type { ServerEvent, ServerEventType } from "@/lib/contracts/events"

const JTAG_EVENTS: readonly ServerEventType[] = ["jtag.changed"]
const LABEL_EVENTS: readonly ServerEventType[] = ["cable-labels.changed"]

/** JTAG cables and cable labels, kept live by `jtag.changed` (admins) and `cable-labels.changed`. */
export function useLiveCables(jtag: JtagSnapshotDTO, labels: CableLabelDTO[]): { jtag: JtagSnapshotDTO; labels: CableLabelDTO[] } {
  const liveJtag = useLiveState(jtag, JTAG_EVENTS, (s, e: ServerEvent) => (e.type === "jtag.changed" ? e.snapshot : s))
  const liveLabels = useLiveState(labels, LABEL_EVENTS, (s, e: ServerEvent) => (e.type === "cable-labels.changed" ? e.labels : s))
  return { jtag: liveJtag, labels: liveLabels }
}
