"use client"

import * as React from "react"
import { ChevronDownIcon, LockOpenIcon, PencilIcon, ShieldOffIcon, TimerResetIcon } from "lucide-react"
import { SplitButton } from "@/components/common/split-button"
import { InlineAlert } from "@/components/common/inline-alert"
import { Countdown } from "@/components/common/countdown"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useServerNow } from "@/components/providers/server-clock-provider"
import { useEquipment } from "@/components/workspace/equipment-context"
import { useMounted } from "@/hooks/use-mounted"
import { reservation as t } from "@/lib/i18n/banco"
import { cn } from "@/lib/client/cn"
import { announcementText, initialAnnouncements, isReservable, nextAnnouncement } from "./reservation-model"
import { ReservationChip, useReservationView } from "./reservation-chip"
import { ForceReleaseDialog, NoteDialog, NoteForm } from "./reservation-dialogs"
import { RemoteSessionsChip, useReleaseWithSessions } from "./remote-sessions"
import { sessionText } from "@/lib/i18n/accesses"

/**
 * The single polite region of the reservation control (§8.9, §8.12). It speaks exactly twice per expiry: at the
 * warning threshold and at 60 s. The text is written to the DOM node directly, so no render depends on the
 * ticking clock and the digits never enter a live region.
 */
function ExpiryAnnouncer() {
  const { equipment, reservation, viewer, warningMin } = useEquipment()
  const now = useServerNow()
  const mounted = useMounted()
  const region = React.useRef<HTMLDivElement>(null)
  const state = React.useRef(initialAnnouncements())
  React.useEffect(() => {
    if (!mounted) return
    const mine = reservation && reservation.holderId === viewer.id ? reservation : null
    const left = mine ? Date.parse(mine.expiresAt) - now : Number.NaN
    const step = nextAnnouncement(state.current, mine, left, warningMin)
    state.current = step.state
    if (step.announce && region.current) region.current.textContent = announcementText(step.announce, equipment.name, left)
  }, [mounted, now, reservation, viewer.id, warningMin, equipment.name])
  return <div ref={region} role="status" aria-live="polite" className="sr-only" data-testid="reservation-announcer" />
}

/**
 * Reservation bar of the workspace (§8.9 `ReservationControl`):
 * - free: SplitButton "Reservar" (one click, no note) + chevron "Reservar con motivo"
 * - mine: countdown chip (its menu: "Editar motivo"), "Mantener", "Liberar"
 * - someone else's: chip with holder, until-time and note; admins get "Forzar liberación"
 */
export function ReservationControl({ className }: { className?: string }) {
  const { equipment, reservation, viewer, warningMin, actions, sessions } = useEquipment()
  const view = useReservationView(reservation, viewer.id, warningMin)
  const releaser = useReleaseWithSessions(sessions, equipment.name, actions.release)
  const [splitOpen, setSplitOpen] = React.useState(false)
  const [noteOpen, setNoteOpen] = React.useState(false)
  const [forceOpen, setForceOpen] = React.useState(false)

  let body: React.ReactNode
  if (view.kind === "free" && !isReservable(equipment)) {
    // Nothing to operate (0 consoles, 0 relays): no "Reservar", same as its Banco card. A held reservation still
    // shows its chip and "Liberar" below.
    body = null
  } else if (view.kind === "free") {
    body = (
      <SplitButton
        onClick={() => void actions.reserve(null)}
        menuLabel={t.reserveWithNote}
        pending={actions.pending.reserve}
        open={splitOpen}
        onOpenChange={setSplitOpen}
        popover={splitOpen ? (
          <NoteForm
            submitLabel={t.reserve}
            pending={actions.pending.reserve}
            onSubmit={async (note) => {
              if (await actions.reserve(note)) setSplitOpen(false)
            }}
          />
        ) : null}
      >
        {t.reserve}
      </SplitButton>
    )
  } else if (view.kind === "mine") {
    body = (
      <>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={t.chipMenu}
              className="press inline-flex min-w-0 items-center gap-0.5 rounded-sm hover:brightness-110"
            >
              {/* While the expiry alert is up it owns the countdown; the chip keeps only the lock and "Tuyo". */}
              <ReservationChip view={view} withTooltip={false} hideCountdown={view.phase !== "normal"} />
              <ChevronDownIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            <DropdownMenuLabel className="text-meta whitespace-normal">{view.note ? t.noteOf(view.note) : t.noteField}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => setNoteOpen(true)}>
              <PencilIcon aria-hidden />
              {t.editNote}
            </DropdownMenuItem>
            {/* Phones: "Liberar" lives here so the bar stays one row (chip · Mantener · ⋯). */}
            <DropdownMenuItem className="sm:hidden" disabled={actions.pending.release} onSelect={releaser.requestRelease}>
              <LockOpenIcon aria-hidden />
              {t.release}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button onClick={() => void actions.keep()} disabled={actions.pending.keep} aria-busy={actions.pending.keep || undefined}>
          <TimerResetIcon aria-hidden />
          {t.keep}
        </Button>
        <Button variant="outline" className="max-sm:hidden" onClick={releaser.requestRelease} disabled={actions.pending.release} aria-busy={actions.pending.release || undefined}>
          <LockOpenIcon aria-hidden />
          {t.release}
        </Button>
        <NoteDialog
          open={noteOpen}
          onOpenChange={setNoteOpen}
          equipmentName={equipment.name}
          initial={view.note ?? ""}
          pending={actions.pending.reserve}
          onSave={actions.saveNote}
        />
        {releaser.dialog}
      </>
    )
  } else {
    body = (
      <>
        <ReservationChip view={view} />
        {viewer.isAdmin ? (
          <>
            <Button variant="danger-outline" onClick={() => setForceOpen(true)}>
              <ShieldOffIcon aria-hidden />
              {t.forceRelease}
            </Button>
            <ForceReleaseDialog
              open={forceOpen}
              onOpenChange={setForceOpen}
              equipmentName={equipment.name}
              holderName={view.holderName}
              onConfirm={actions.forceRelease}
              sessions={sessions}
            />
          </>
        ) : null}
      </>
    )
  }

  return (
    <div
      data-slot="reservation-control"
      data-state={view.kind}
      className={cn(
        "flex min-w-0 flex-wrap items-center justify-end gap-2",
        view.kind === "mine" && "max-sm:flex-1 max-sm:flex-nowrap max-sm:justify-between",
        className,
      )}
    >
      <RemoteSessionsChip sessions={sessions} className="max-sm:hidden" />
      {body}
      <ExpiryAnnouncer />
    </div>
  )
}

/**
 * Visible near-expiry alert for the holder (§8.9): no live role (the announcer speaks), countdown and "Mantener".
 * Danger under 60 s.
 */
export function ReservationExpiryAlert({ className }: { className?: string }) {
  const { reservation, viewer, warningMin, actions, sessions } = useEquipment()
  const view = useReservationView(reservation, viewer.id, warningMin)
  if (view.kind !== "mine" || view.phase === "normal") return null
  const cut = sessions.filter((s) => s.onRelease === "closed")
  return (
    <InlineAlert
      tone={view.phase === "critical" ? "danger" : "warn"}
      icon={TimerResetIcon}
      className={cn("py-2", className)}
      title={<>{t.expiringTitle} · <Countdown expiresAt={view.expiresAt} className="font-mono" /></>}
      actions={(
        <Button size="sm" variant="primary" onClick={() => void actions.keep()} disabled={actions.pending.keep} aria-busy={actions.pending.keep || undefined}>
          {t.keep}
        </Button>
      )}
    >
      <span className="text-meta">{t.expiringBody}</span>
      {sessions.length ? (
        <span className="mt-0.5 block text-meta" data-testid="expiry-sessions">
          {sessionText.expiring(sessions.length)}{cut.length ? ` ${cut.map((s) => s.text).join("; ")}.` : ""}
        </span>
      ) : null}
    </InlineAlert>
  )
}
