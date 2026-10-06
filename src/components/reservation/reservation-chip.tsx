"use client"

import * as React from "react"
import { CircleIcon, ClockIcon, LockIcon, TimerResetIcon } from "lucide-react"
import { StatusChip, type ChipTone } from "@/components/common/status-chip"
import { Countdown } from "@/components/common/countdown"
import { SimpleTooltip } from "@/components/ui/tooltip"
import { useStale } from "@/components/providers/events-provider"
import { useServerNow } from "@/components/providers/server-clock-provider"
import type { ReservationDTO } from "@/lib/contracts/reservations"
import { formatTime } from "@/lib/i18n/format"
import { reservation as t } from "@/lib/i18n/banco"
import { useMounted } from "@/hooks/use-mounted"
import { cn } from "@/lib/client/cn"
import { reservationView, type ReservationView } from "./reservation-model"

/** A clock time ("13:42") in the browser's zone; the server's zone may differ, so hydration may differ too. */
export function ClockTime({ value, className }: { value: string; className?: string }) {
  return (
    <time dateTime={value} suppressHydrationWarning className={cn("tabular-nums", className)}>
      {formatTime(value)}
    </time>
  )
}

/** The live reservation view on the server clock (null clock before mount, so the markup never depends on it). */
export function useReservationView(r: ReservationDTO | null, viewerId: string, warningMin: number): ReservationView {
  const now = useServerNow()
  const mounted = useMounted()
  return reservationView(r, viewerId, mounted ? now : null, warningMin)
}

function tone(v: ReservationView): ChipTone {
  if (v.kind === "free") return "neutral"
  if (v.kind === "other") return "warn"
  return v.phase === "critical" ? "danger" : v.phase === "warning" ? "warn" : "brand"
}

/**
 * Reservation state chip (§8.6): "Libre" (hollow circle, faint), "Tuyo · 24:13" (brand, lock), "Expira en 0:48"
 * (warn, then danger under 60 s), "J. Duro · hasta 13:42" (warn, lock). The note shows in the tooltip. With no live
 * connection it adds "Estado no actualizado". The countdown digits are never in a live region.
 */
export function ReservationChip({ view, className, compact = false, withTooltip = true, hideCountdown = false }: {
  view: ReservationView
  className?: string
  /** Banco cards: the stale flag becomes an icon with a tooltip instead of text. The card prints the note itself
   * ("Motivo: …"), so the chip does not repeat it to screen readers. */
  compact?: boolean
  withTooltip?: boolean
  /** Workspace header while the expiry alert shows the countdown: lock + "Tuyo", no digits (one countdown per view). */
  hideCountdown?: boolean
}) {
  const stale = useStale()
  const tn = tone(view)
  let icon = LockIcon
  let body: React.ReactNode
  if (view.kind === "free") {
    icon = CircleIcon
    body = t.free
  } else if (view.kind === "mine") {
    if (hideCountdown) {
      body = t.mineShort
    } else if (view.phase === "normal") {
      body = <>{t.mineShort} · <Countdown expiresAt={view.expiresAt} /></>
    } else {
      icon = TimerResetIcon
      body = <>{t.expiresPrefix} <Countdown expiresAt={view.expiresAt} /></>
    }
  } else {
    body = <>{view.holderShort} · {t.untilPrefix} <ClockTime value={view.expiresAt} /></>
  }
  const chip = (
    <StatusChip
      tone={tn}
      icon={icon}
      quiet={view.kind === "free"}
      className={cn(view.kind === "free" && "text-muted-foreground", "max-w-full", className)}
      iconClassName={view.kind === "free" ? "text-faint-foreground" : undefined}
    >
      {body}
      {stale && !compact ? <span className="text-muted-foreground"> · {t.staleSuffix}</span> : null}
    </StatusChip>
  )
  const note = view.kind !== "free" ? view.note : null
  const tip = [
    view.kind === "other" ? t.heldBy(view.holderName) : null,
    note ? t.noteOf(note) : null,
    stale ? t.staleSuffix : null,
  ].filter(Boolean)
  const staleIcon = stale && compact ? (
    <>
      <ClockIcon aria-hidden className="size-3.5 shrink-0 text-faint-foreground" />
      <span className="sr-only">{t.staleSuffix}</span>
    </>
  ) : null
  if (!withTooltip || !tip.length) return <span className="inline-flex min-w-0 items-center gap-1">{chip}{staleIcon}</span>
  return (
    <SimpleTooltip label={<span className="flex flex-col">{tip.map((l) => <span key={l}>{l}</span>)}</span>}>
      <span tabIndex={0} className="inline-flex min-w-0 items-center gap-1 rounded-sm">
        {chip}
        {staleIcon}
      </span>
    </SimpleTooltip>
  )
}
