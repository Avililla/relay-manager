"use client"

import * as React from "react"
import type { IsoDate } from "@/lib/contracts/common"
import { useServerNow } from "@/components/providers/server-clock-provider"
import { common } from "@/lib/i18n/shell"
import { useMounted } from "@/hooks/use-mounted"
import { cn } from "@/lib/client/cn"
import { viewerDateTime } from "@/lib/client/local-time"

const rtf = new Intl.RelativeTimeFormat("es", { numeric: "auto" })

/** "hace 3 minutos", "ayer"… from a difference in ms (negative = past). Pure. */
export function relativeText(diffMs: number): string {
  const s = Math.round(diffMs / 1000)
  const abs = Math.abs(s)
  if (abs < 45) return common.justNow
  if (abs < 45 * 60) return rtf.format(Math.round(s / 60), "minute")
  if (abs < 22 * 3600) return rtf.format(Math.round(s / 3600), "hour")
  if (abs < 26 * 86400) return rtf.format(Math.round(s / 86400), "day")
  if (abs < 320 * 86400) return rtf.format(Math.round(s / (30 * 86400)), "month")
  return rtf.format(Math.round(s / (365 * 86400)), "year")
}

/**
 * Relative time on the server clock ("hace 5 minutos"), with the absolute date in the tooltip (`title`). Before mount
 * both are a stable UTC text, so server and client markup agree; after mount the title is the browser's local time.
 */
export function RelativeTime({ value, className }: { value: IsoDate; className?: string }) {
  const now = useServerNow()
  const mounted = useMounted()
  const abs = viewerDateTime(value, mounted)
  const text = mounted ? relativeText(Date.parse(value) - now) : abs
  return (
    <time dateTime={value} title={abs} className={cn("tabular-nums", className)}>
      {text}
    </time>
  )
}
