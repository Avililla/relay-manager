"use client"

import * as React from "react"
import { CirclePauseIcon, PlugIcon, TimerResetIcon } from "lucide-react"
import { AppLink } from "@/components/common/app-link"
import { SimpleTooltip } from "@/components/ui/tooltip"
import { tagVariants } from "@/components/ui/tag"
import { useServerNow } from "@/components/providers/server-clock-provider"
import type { SerialSnapshotDTO } from "@/lib/contracts/serial"
import { formatDuration } from "@/lib/i18n/format"
import { shell } from "@/lib/i18n/shell"
import { useLiveState } from "@/hooks/use-live-state"
import { useMounted } from "@/hooks/use-mounted"
import { cn } from "@/lib/client/cn"
import { setTitlePrefix } from "@/lib/client/doc-title"
import { displayRemainingMs } from "@/lib/client/countdown"
import { countUnassignedPorts } from "@/lib/client/serial-count"
import { useShell } from "./shell-context"

const SERIAL_EVENTS = ["serial.changed"] as const
const CONSOLE_STATUS_EVENTS = ["console.status"] as const

/**
 * Unassigned serial ports in a snapshot, counted exactly like the server's first value (USB, virtual and builtin
 * ports without a console; JTAG-probable ports only while they are hidden): see `countUnassignedPorts`.
 */
export function countUnassigned(s: SerialSnapshotDTO): number {
  return countUnassignedPorts(s)
}

/** Admin only: "N puertos sin asignar" → /descubrimiento; hidden at 0; icon + count below 640 px (§8.1). */
export function UnassignedPortsLink() {
  const { shell: s } = useShell()
  const n = useLiveState(s.unassignedPorts, SERIAL_EVENTS, (v, e) => (e.type === "serial.changed" ? countUnassigned(e.snapshot) : v))
  if (!s.viewer.isAdmin || !n) return null
  const label = shell.unassignedPorts(n)
  return (
    <SimpleTooltip label={label}>
      <AppLink
        href="/descubrimiento"
        aria-label={label}
        className="inline-flex h-7 items-center gap-1.5 rounded-md border border-input px-2 text-meta text-muted-foreground hover:border-control-border hover:text-foreground"
      >
        <PlugIcon aria-hidden className="size-3.5" />
        <span className="font-mono tabular-nums sm:hidden">{n}</span>
        <span className="max-sm:hidden">{label}</span>
      </AppLink>
    </SimpleTooltip>
  )
}

/** Admin only: warn chip while capture is paused for low disk space → /sistema/salud. */
export function CapturePausedChip() {
  const { shell: s } = useShell()
  // The disk guard is global: any console reporting "paused-disk" or "active" tells the current state.
  const paused = useLiveState(!!s.capturePaused, CONSOLE_STATUS_EVENTS, (v, e) =>
    e.type === "console.status" && e.runtime.capture === "paused-disk" ? true
      : e.type === "console.status" && e.runtime.capture === "active" ? false : v)
  if (!s.viewer.isAdmin || !paused) return null
  return (
    <SimpleTooltip label={shell.capturePausedHint}>
      <AppLink href="/sistema/salud" className={cn(tagVariants({ tone: "warn" }), "h-7 px-2 text-meta hover:bg-warn-tint/80")}>
        <CirclePauseIcon aria-hidden />
        <span className="max-sm:sr-only">{shell.capturePaused}</span>
      </AppLink>
    </SimpleTooltip>
  )
}

/**
 * Near-expiry chip (§8.1): while the viewer holds a reservation within `reservationWarningMin` of expiry,
 * "Reserva de <equipo> · m:ss" links to the workspace; `document.title` gets "(Expira m:ss) ". The ticking digits
 * are not in a live region.
 */
export function ReservationExpiryChip() {
  const { shell: s } = useShell()
  const now = useServerNow()
  const mounted = useMounted()
  const warnMs = s.reservationWarningMin * 60_000
  const near = mounted
    ? s.myReservations
      .map((r) => ({ ...r, left: displayRemainingMs(r.expiresAt, now) }))
      .filter((r) => Number.isFinite(r.left) && r.left <= warnMs)
      .sort((a, b) => a.left - b.left)
    : []
  const first = near[0]
  const titleLeft = first ? formatDuration(Math.max(0, Math.ceil(first.left / 1000) * 1000)) : null

  React.useEffect(() => {
    // In place on the head's existing <title>: `document.title = …` would append a stray <title> mid-navigation.
    if (!titleLeft) return
    const prefix = shell.reservationTitlePrefix(titleLeft)
    setTitlePrefix(document, prefix)
    // Next rewrites the page <title> on navigations and refreshes: put the prefix back at once (a no-op when present).
    // The title can sit in <body> (streamed metadata), so watch its own node too, not just <head>.
    const observer = new MutationObserver(() => setTitlePrefix(document, prefix))
    observer.observe(document.head, { childList: true, subtree: true, characterData: true })
    const title = document.querySelector("title")
    if (title && title.parentNode !== document.head) observer.observe(title, { childList: true, subtree: true, characterData: true })
    return () => {
      observer.disconnect()
      setTitlePrefix(document, null)
    }
  }, [titleLeft])

  if (!near.length) return null
  return (
    <>
      {near.map((r) => {
        const left = formatDuration(Math.max(0, Math.ceil(r.left / 1000) * 1000))
        const label = shell.reservationChip(r.equipmentName, left)
        return (
          <AppLink
            key={r.equipmentId}
            href={`/equipos/${r.equipmentId}`}
            className={cn(tagVariants({ tone: r.left < 60_000 ? "danger" : "warn" }), "h-7 px-2 text-meta tabular-nums")}
          >
            <TimerResetIcon aria-hidden />
            <span className="max-md:hidden">{label}</span>
            <span className="md:hidden">{left}</span>
          </AppLink>
        )
      })}
    </>
  )
}

/** Optional strip above the top bar when a banner text is set (24 px, warn tint, centred, --foreground text). */
export function BannerStrip() {
  const { shell: s } = useShell()
  if (!s.bannerText) return null
  return (
    <div className="flex h-6 shrink-0 items-center justify-center overflow-hidden bg-warn-tint px-4 text-meta text-foreground shadow-[inset_0_-1px_0_var(--border)]">
      <p className="truncate">{s.bannerText}</p>
    </div>
  )
}
