"use client"

import * as React from "react"
import type { IsoDate } from "@/lib/contracts/common"
import { useServerNow } from "@/components/providers/server-clock-provider"
import { countdownView } from "@/lib/client/countdown"
import { useMounted } from "@/hooks/use-mounted"
import { cn } from "@/lib/client/cn"

/**
 * Countdown to `expiresAt` on the server clock (§8.8): "hasta 13:42" on the server and until mounted (no hydration
 * mismatch), then "m:ss"; at ≤ 0 "Expirando…" until `reservation.changed` arrives. Never put it inside a live
 * region: the digits tick every second.
 */
export function Countdown({ expiresAt, className, prefix }: { expiresAt: IsoDate; className?: string; prefix?: string }) {
  const serverNow = useServerNow()
  const mounted = useMounted()
  // `serverNow` already includes the clock offset.
  const view = countdownView({ expiresAt, mounted, clientNow: serverNow, offset: 0 })
  return (
    <time dateTime={expiresAt} suppressHydrationWarning className={cn("tabular-nums", className)} data-kind={view.kind}>
      {prefix}
      {view.text}
    </time>
  )
}

/** Remaining milliseconds on the server clock (re-renders once per second). NaN before mount. */
export function useRemainingMs(expiresAt: IsoDate): number {
  const serverNow = useServerNow()
  const mounted = useMounted()
  return mounted ? Date.parse(expiresAt) - serverNow : Number.NaN
}
