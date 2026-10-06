"use client"

import * as React from "react"
import { ClockIcon, LoaderCircleIcon, LockIcon, PanelRightCloseIcon, PanelRightOpenIcon, RefreshCwIcon, TriangleAlertIcon } from "lucide-react"
import { toast } from "sonner"
import { pulseRelay, refreshEquipmentRelays, setRelay } from "@/actions/relays"
import { ConfirmPopover } from "@/components/common/confirm-popover"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { SimpleTooltip } from "@/components/ui/tooltip"
import { useStale } from "@/components/providers/events-provider"
import type { RelayChannelSummaryDTO } from "@/lib/contracts/equipment"
import { useAction } from "@/hooks/use-action"
import { formatTime } from "@/lib/i18n/format"
import { relayPurposeLabel } from "@/lib/i18n/status"
import { relays as t } from "@/lib/i18n/banco"
import { RELAY_TEXT } from "@/lib/i18n/relays"
import { useMounted } from "@/hooks/use-mounted"
import { cn } from "@/lib/client/cn"
import { PURPOSE_ICON } from "./relay-icons"
import { confirmFor, relayControl, relayStateView } from "./relay-model"
import { RelayStateBadge } from "./relay-state-chip"

/** The question with the equipment name kept on one line ("Equipo A #07" never breaks at its hyphen). */
function Question({ text, name }: { text: string; name: string }) {
  const i = text.indexOf(name)
  if (i < 0) return <>{text}</>
  return <>{text.slice(0, i)}<span className="whitespace-nowrap">{name}</span>{text.slice(i + name.length)}</>
}

/** Wraps a control that is disabled for non-holders with the "Reserva el equipo para actuar" tooltip. */
function Gate({ locked, children }: { locked: boolean; children: React.ReactElement }) {
  if (!locked) return children
  return (
    <SimpleTooltip label={t.needReservation}>
      <span tabIndex={0} className="inline-flex rounded-md">{children}</span>
    </SimpleTooltip>
  )
}

/**
 * One relay row (§8.9): label, purpose icon, `board · canal N`, state and the control. Absolute set with no
 * optimistic flip: while a command is in flight the control is busy ("Aplicando…") and a failure is explained by
 * a toast. `requireConfirm` asks before OFF and before a pulse.
 */
export function RelayRow({ relay: r, equipmentId, equipmentName, canAct, lastAt, full = false, compact = false }: {
  relay: RelayChannelSummaryDTO
  equipmentId: string
  equipmentName: string
  canAct: boolean
  lastAt: string | null
  /** 0-console units: the row spans the page width. */
  full?: boolean
  /** The 240 px rail: the label wraps to two lines and the state badge moves to the `board · canal N` line. */
  compact?: boolean
}) {
  const connectionStale = useStale()
  const mounted = useMounted()
  const set = useAction(setRelay)
  const pulse = useAction(pulseRelay)
  const [pendingOn, setPendingOn] = React.useState<boolean | null>(null)
  const busy = set.pending || pulse.pending
  const control = relayControl(r, connectionStale)
  const view = relayStateView(r, connectionStale)
  const Icon = PURPOSE_ICON[r.purpose]
  const locked = !canAct
  const offline = r.boardOnline === false

  const apply = async (on: boolean) => {
    setPendingOn(on)
    const res = await set.run({ equipmentId, channelId: r.id, on, confirmed: !!confirmFor(r, on ? "on" : "off", equipmentName) })
    setPendingOn(null)
    return res.ok
  }
  const doPulse = async (ms: number) => {
    const res = await pulse.run({ equipmentId, channelId: r.id, ms, confirmed: !!confirmFor(r, "pulse", equipmentName) })
    if (res.ok) toast.success(t.pulseDone(r.label))
  }

  let ctl: React.ReactNode
  if (control.kind === "pulse") {
    const q = confirmFor(r, "pulse", equipmentName)
    const btn = (
      <Button size="sm" disabled={locked || busy} aria-busy={pulse.pending || undefined} onClick={q ? undefined : () => void doPulse(control.ms)}>
        {pulse.pending ? <LoaderCircleIcon aria-hidden className="animate-spin motion-reduce:hidden" /> : null}
        {pulse.pending ? t.applying : t.pulse}
      </Button>
    )
    ctl = (
      <span className="inline-flex items-center gap-1.5">
        {control.emulated ? (
          <SimpleTooltip label={RELAY_TEXT.pulseEmulatedWarning}>
            <span tabIndex={0} className="inline-flex rounded-sm">
              <TriangleAlertIcon aria-label={t.emulated} className="size-3.5 text-warn" />
            </span>
          </SimpleTooltip>
        ) : null}
        <Gate locked={locked}>
          {q && !locked ? (
            <ConfirmPopover trigger={btn} question={<Question text={q} name={equipmentName} />} confirmLabel={t.pulse} onConfirm={() => void doPulse(control.ms)} />
          ) : locked ? btn : <SimpleTooltip label={t.pulseTooltip(control.ms)}>{btn}</SimpleTooltip>}
        </Gate>
      </span>
    )
  } else if (control.kind === "on-off") {
    const qOff = confirmFor(r, "off", equipmentName)
    const offBtn = (
      <Button size="sm" disabled={locked || busy} aria-busy={pendingOn === false || undefined} onClick={qOff ? undefined : () => void apply(false)}>
        {t.off}
      </Button>
    )
    ctl = (
      <Gate locked={locked}>
        <span className="inline-flex items-center gap-1.5">
          <Button size="sm" disabled={locked || busy} aria-busy={pendingOn === true || undefined} onClick={() => void apply(true)}>{t.on}</Button>
          {qOff && !locked ? <ConfirmPopover trigger={offBtn} question={<Question text={qOff} name={equipmentName} />} confirmLabel={t.off} onConfirm={() => void apply(false)} /> : offBtn}
        </span>
      </Gate>
    )
  } else {
    const on = r.on === true
    const qOff = on ? confirmFor(r, "off", equipmentName) : null
    const sw = (
      <Switch
        tone="ok"
        checked={on}
        aria-label={r.label}
        aria-busy={set.pending || undefined}
        disabled={locked || busy}
        onCheckedChange={qOff ? undefined : (v) => void apply(v)}
        className={cn(set.pending && "opacity-60")}
      />
    )
    ctl = (
      <Gate locked={locked}>
        {qOff && !locked ? (
          <ConfirmPopover trigger={sw} question={<Question text={qOff} name={equipmentName} />} confirmLabel={t.off} onConfirm={() => void apply(false)} />
        ) : sw}
      </Gate>
    )
  }

  const twoButtons = control.kind === "on-off" && !full
  const badge = r.purpose !== "reset" ? <RelayStateBadge view={view} /> : null

  // While a command is in flight the control is busy and says "Aplicando…"; the state changes only when the board
  // confirms it (relay.state), never optimistically.
  // A pulse already says "Aplicando…" on its own button; the state line only covers the switch / ON-OFF set.
  const stateLine = set.pending ? (
    <span className="text-meta text-muted-foreground">{t.applying}</span>
  ) : offline ? (
    <span className="inline-flex items-center gap-1 text-meta text-foreground"><TriangleAlertIcon aria-hidden className="size-3.5 text-danger" />{t.boardOffline(r.boardName)}</span>
  ) : view.stale ? (
    <span className="inline-flex items-center gap-1 text-meta text-faint-foreground">
      <ClockIcon aria-hidden className="size-3.5" />
      {lastAt && mounted && !connectionStale ? t.lastState(formatTime(lastAt)) : t.staleState}
    </span>
  ) : null

  return (
    <li
      data-relay-id={r.id}
      data-state={view.tone}
      className={cn("grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-0.5 border-b px-3 py-2 last:border-b-0", full && "sm:px-4")}
    >
      <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <span
        className={cn("min-w-0 text-body font-medium text-foreground", compact ? "line-clamp-2 break-words" : "truncate")}
        title={`${r.label} · ${relayPurposeLabel(r.purpose)}`}
      >
        {r.label}
      </span>
      <div className="flex shrink-0 items-center justify-end gap-2">
        {/* In the 240 px rail the state moves to the `board · canal N` line, so the label keeps the width. */}
        {compact ? null : badge}
        {twoButtons ? null : ctl}
      </div>
      {/* "Encender" / "Apagar" do not fit beside the label in the 240 px rail: they get their own line. */}
      {twoButtons ? <div className="col-span-2 col-start-2 flex min-w-0 pt-1 pb-0.5">{ctl}</div> : null}
      <div className="col-span-2 col-start-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className="truncate font-mono text-micro font-normal tracking-normal text-muted-foreground">{t.location(r.boardName, r.channel)}</span>
        {compact ? badge : null}
        {stateLine}
      </div>
    </li>
  )
}

/**
 * Relays of the unit (§8.9 relay rail, only when it has relays): 240 px on the right, collapsible; below 768 px it
 * is the last tab; with 0 consoles it fills the body with full-width rows. Non-holders see the state with the
 * controls disabled ("Reserva el equipo para actuar").
 */
export function RelayRail({ id, className, relays, equipmentId, equipmentName, canAct, lastAt, variant = "rail", collapsed = false, onCollapsedChange }: {
  /** Target of the workspace skip link ("Ir a relés"); the landmark takes focus programmatically only. */
  id?: string
  className?: string
  relays: RelayChannelSummaryDTO[]
  equipmentId: string
  equipmentName: string
  canAct: boolean
  lastAt: string | null
  variant?: "rail" | "full" | "tab"
  collapsed?: boolean
  onCollapsedChange?: (c: boolean) => void
}) {
  const refresh = useAction(refreshEquipmentRelays)
  const headingId = React.useId()
  if (variant === "rail" && collapsed) {
    return (
      <aside id={id} tabIndex={-1} aria-label={t.railLabel} className={cn("flex w-10 shrink-0 flex-col items-center gap-2 border-l bg-card py-2 outline-none", className)}>
        <SimpleTooltip label={t.expand} side="left">
          <Button variant="ghost" size="icon-sm" aria-label={t.expand} aria-expanded={false} onClick={() => onCollapsedChange?.(false)}>
            <PanelRightOpenIcon aria-hidden />
          </Button>
        </SimpleTooltip>
        <span className="font-mono text-micro text-muted-foreground tabular-nums">{relays.length}</span>
      </aside>
    )
  }
  return (
    <section
      id={id}
      tabIndex={-1}
      aria-labelledby={headingId}
      className={cn(
        "flex min-h-0 flex-col bg-card outline-none",
        variant === "rail" && "w-60 shrink-0 border-l",
        variant === "full" && "w-full rounded-lg border",
        variant === "tab" && "h-full rounded-md border",
        className,
      )}
    >
      <div className="flex h-9 shrink-0 items-center gap-1 border-b pr-1 pl-3">
        <h2 id={headingId} className="mr-auto text-section text-foreground">{t.rail} <span className="font-mono text-meta text-muted-foreground tabular-nums">{relays.length}</span></h2>
        <SimpleTooltip label={t.refresh}>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t.refresh}
            disabled={refresh.pending}
            aria-busy={refresh.pending || undefined}
            onClick={async () => {
              const r = await refresh.run({ equipmentId })
              if (r.ok) toast.success(t.refreshed)
            }}
          >
            <RefreshCwIcon aria-hidden className={cn(refresh.pending && "animate-spin motion-reduce:animate-none")} />
          </Button>
        </SimpleTooltip>
        {variant === "rail" ? (
          <SimpleTooltip label={t.collapse}>
            <Button variant="ghost" size="icon-sm" aria-label={t.collapse} aria-expanded onClick={() => onCollapsedChange?.(true)}>
              <PanelRightCloseIcon aria-hidden />
            </Button>
          </SimpleTooltip>
        ) : null}
      </div>
      {/* The reason the controls are disabled sits right above them, not at the foot of a tall rail. */}
      {!canAct ? (
        <p className="flex shrink-0 items-center gap-1.5 border-b px-3 py-1.5 text-meta text-muted-foreground">
          <LockIcon aria-hidden className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate">{t.needReservation}</span>
        </p>
      ) : null}
      <ul className="min-h-0 flex-1 overflow-y-auto">
        {relays.map((r) => (
          <RelayRow key={r.id} relay={r} equipmentId={equipmentId} equipmentName={equipmentName} canAct={canAct} lastAt={lastAt} full={variant === "full"} compact={variant === "rail"} />
        ))}
      </ul>
    </section>
  )
}
