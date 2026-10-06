"use client"

import * as React from "react"
import { StatusDot, type StatusTone } from "@/components/common/status-dot"
import { SimpleTooltip } from "@/components/ui/tooltip"
import { useConnectionState, useStale } from "@/components/providers/events-provider"
import { connection } from "@/lib/i18n/shell"
import { cn } from "@/lib/client/cn"

/**
 * "En vivo" / "Reconectando…" / "Sin conexión"; after 5 s without an open connection "Sin conexión con el
 * servidor" (§8.1, §8.11). A polite live region announces changes once; the label never ticks.
 */
export function ConnectionIndicator({ className, compact = false }: { className?: string; compact?: boolean }) {
  const state = useConnectionState()
  const stale = useStale()
  let tone: StatusTone
  let label: string
  if (state === "open") {
    tone = "ok"
    label = connection.live
  } else if (stale) {
    tone = "danger"
    label = connection.offlineLong
  } else if (state === "closed") {
    tone = "danger"
    label = connection.offline
  } else if (state === "reconnecting") {
    tone = "warn"
    label = connection.reconnecting
  } else {
    tone = "faint"
    label = connection.connecting
  }
  const content = (
    <span role="status" className={cn("inline-flex h-7 items-center gap-1.5 rounded-md px-1.5 text-meta text-muted-foreground", className)}>
      <StatusDot tone={tone} />
      <span className="sr-only">{connection.label}: </span>
      <span className={cn(compact && "sr-only")}>{label}</span>
    </span>
  )
  return compact ? <SimpleTooltip label={label}>{content}</SimpleTooltip> : content
}
