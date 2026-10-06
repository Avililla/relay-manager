"use client"

import * as React from "react"
import {
  NetworkIcon,
  EllipsisIcon, LockOpenIcon, PencilIcon, SettingsIcon, ShieldOffIcon, SquareTerminalIcon, TimerResetIcon, ToggleRightIcon, TriangleAlertIcon,
} from "lucide-react"
import { AppLink } from "@/components/common/app-link"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Tag } from "@/components/ui/tag"
import { SimpleTooltip } from "@/components/ui/tooltip"
import { ConsoleChannelStrip } from "@/components/serial/console-channel-strip"
import { useServerNow } from "@/components/providers/server-clock-provider"
import { RelayStateChip } from "@/components/relays/relay-state-chip"
import { ReservationChip, useReservationView } from "@/components/reservation/reservation-chip"
import { ForceReleaseDialog, NoteDialog } from "@/components/reservation/reservation-dialogs"
import { useReservationActions } from "@/components/reservation/use-reservation-actions"
import type { EquipmentCardDTO } from "@/lib/contracts/equipment"
import type { ViewerDTO } from "@/lib/contracts/users"
import { useMounted } from "@/hooks/use-mounted"
import { banco as t, relays as rt } from "@/lib/i18n/banco"
import { cn } from "@/lib/client/cn"
import { accessUi } from "@/lib/i18n/accesses"
import { unitSummary } from "./banco-model"
import { remoteSessions } from "@/components/accesses/access-model"
import { RemoteSessionsChip, useReleaseWithSessions } from "@/components/reservation/remote-sessions"

const MAX_STRIPS = 6
const MAX_RELAYS = 4

/** Visible text plus the unit name for screen readers ("Reservar Equipo A #07"). */
function Named({ text, name }: { text: string; name: string }) {
  return <>{text}<span className="sr-only"> {name}</span></>
}

/**
 * One unit on the Banco (§8.9 `EquipmentUnit`): name (link to the workspace), template, S/N and reservation chip;
 * the console channel strips; read-only relay chips only when the unit has relays; and the actions for its
 * reservation state (free: Reservar + Ver consolas; mine: Abrir consolas + ⋯; someone else's: Ver consolas, and
 * admins get "Forzar liberación…" in ⋯). The unit's edge shows the summary: brand when it is the viewer's, danger
 * when a console or board has a problem.
 */
export function EquipmentUnit({ card, viewer, warningMin, stale }: { card: EquipmentCardDTO; viewer: ViewerDTO; warningMin: number; stale: boolean }) {
  const view = useReservationView(card.reservation, viewer.id, warningMin)
  const now = useServerNow()
  const mounted = useMounted()
  const summary = unitSummary(card, viewer.id, mounted ? now : 0)
  const actions = useReservationActions(card.id, card.name)
  const sessions = React.useMemo(() => remoteSessions(card.accesses), [card.accesses])
  const releaser = useReleaseWithSessions(sessions, card.name, actions.release)
  const [dialog, setDialog] = React.useState<"note" | "force" | null>(null)
  const nameId = React.useId()
  const href = `/equipos/${card.id}`
  const hasConsoles = card.consoles.length > 0
  const hasRelays = card.relays.length > 0
  const empty = !hasConsoles && !hasRelays
  const offlineBoards = [...new Set(card.relays.filter((r) => r.boardOnline === false).map((r) => r.boardName))]

  const viewLabel = hasConsoles ? t.viewConsoles : t.viewRelays
  const openLabel = hasConsoles ? t.openConsoles : t.openRelays
  const ViewIcon = hasConsoles ? SquareTerminalIcon : ToggleRightIcon

  const menuItems: React.ReactNode[] = []
  if (view.kind === "mine") {
    menuItems.push(
      <DropdownMenuItem key="keep" onSelect={() => void actions.keep()} disabled={actions.pending.keep}><TimerResetIcon aria-hidden />{t.keep}</DropdownMenuItem>,
      <DropdownMenuItem key="note" onSelect={() => setDialog("note")}><PencilIcon aria-hidden />{t.editNote}</DropdownMenuItem>,
      <DropdownMenuItem key="release" onSelect={releaser.requestRelease} disabled={actions.pending.release}><LockOpenIcon aria-hidden />{t.release}</DropdownMenuItem>,
    )
  }
  if (view.kind === "other" && viewer.isAdmin) {
    menuItems.push(<DropdownMenuItem key="force" variant="danger" onSelect={() => setDialog("force")}><ShieldOffIcon aria-hidden />{t.forceRelease}</DropdownMenuItem>)
  }
  if (viewer.isAdmin && !empty) {
    if (menuItems.length) menuItems.push(<DropdownMenuSeparator key="sep" />)
    menuItems.push(
      <DropdownMenuItem key="settings" asChild>
        <AppLink href={`${href}/ajustes`}><SettingsIcon aria-hidden />{t.settings}</AppLink>
      </DropdownMenuItem>,
    )
  }

  let primary: React.ReactNode = null
  if (empty) {
    primary = viewer.isAdmin ? (
      <Button size="sm" asChild>
        <AppLink href={`${href}/ajustes`}><SettingsIcon aria-hidden /><Named text={t.configure} name={card.name} /></AppLink>
      </Button>
    ) : null
  } else if (view.kind === "free") {
    primary = (
      <>
        <Button size="sm" variant="outline" asChild>
          <AppLink href={href}><ViewIcon aria-hidden /><Named text={viewLabel} name={card.name} /></AppLink>
        </Button>
        <Button size="sm" variant="primary" onClick={() => void actions.reserve(null)} disabled={actions.pending.reserve} aria-busy={actions.pending.reserve || undefined}>
          <Named text={t.reserve} name={card.name} />
        </Button>
      </>
    )
  } else if (view.kind === "mine") {
    primary = (
      <Button size="sm" variant="primary" asChild>
        <AppLink href={href}><ViewIcon aria-hidden /><Named text={openLabel} name={card.name} /></AppLink>
      </Button>
    )
  } else {
    primary = (
      <Button size="sm" variant="outline" asChild>
        <AppLink href={href}><ViewIcon aria-hidden /><Named text={viewLabel} name={card.name} /></AppLink>
      </Button>
    )
  }

  return (
    <article
      aria-labelledby={nameId}
      data-summary={summary}
      data-reservation={view.kind}
      className={cn(
        "flex min-w-0 flex-col rounded-lg border bg-card tint-transition",
        summary === "mine" && "border-brand/40 shadow-[inset_2px_0_0_var(--brand)]",
        summary === "danger" && "shadow-[inset_2px_0_0_var(--danger)]",
      )}
    >
      <header className="flex items-start gap-3 px-3 pt-2.5 pb-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h2 id={nameId} className="min-w-0 truncate text-section text-foreground">
            <AppLink href={href} className="rounded-sm underline-offset-4 hover:underline">{card.name}</AppLink>
          </h2>
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            {card.templateName ? <Tag>{card.templateName}</Tag> : null}
            {card.serialNumber ? <span className="truncate font-mono text-data text-muted-foreground">{card.serialNumber}</span> : null}
          </div>
        </div>
        <div className="flex max-w-[55%] shrink-0 justify-end pt-0.5">
          <ReservationChip view={view} compact />
        </div>
      </header>
      <span className="sr-only">{t.unitSummary[summary]}</span>

      {view.kind !== "free" && view.note ? (
        <p className="-mt-1 truncate px-3 pb-1.5 text-meta text-muted-foreground" title={view.note}>
          {t.noteLabel}: <span className="text-foreground">{view.note}</span>
        </p>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col gap-2 px-3 pb-3">
        {hasConsoles ? (
          <ul aria-label={t.consolesHeading} className="flex min-w-0 flex-col rounded-md bg-muted/60 px-2 py-0.5">
            {card.consoles.slice(0, MAX_STRIPS).map((c) => (
              <li key={c.id} className="min-w-0">
                <ConsoleChannelStrip console={c} />
              </li>
            ))}
            {card.consoles.length > MAX_STRIPS ? (
              <li className="h-7 content-center text-meta text-muted-foreground">
                <AppLink href={href} className="underline-offset-4 hover:underline">{t.moreConsoles(card.consoles.length - MAX_STRIPS)}</AppLink>
              </li>
            ) : null}
          </ul>
        ) : null}

        {card.accesses.length ? (
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <AccessesIndicator href={`${href}/accesos`} accesses={card.accesses} />
            <RemoteSessionsChip sessions={sessions} />
          </div>
        ) : null}

        {hasRelays ? (
          <div className="flex min-w-0 flex-col gap-1.5">
            <ul aria-label={rt.readOnlyChips} className="flex min-w-0 flex-wrap gap-1.5">
              {card.relays.slice(0, MAX_RELAYS).map((r) => <RelayStateChip key={r.id} relay={r} stale={stale} />)}
              {card.relays.length > MAX_RELAYS ? (
                <li className="inline-flex h-6 items-center px-1 text-meta text-muted-foreground">{t.moreRelays(card.relays.length - MAX_RELAYS)}</li>
              ) : null}
            </ul>
            {offlineBoards.map((b) => (
              <p key={b} className="inline-flex items-center gap-1.5 text-meta text-foreground">
                <TriangleAlertIcon aria-hidden className="size-3.5 shrink-0 text-danger" />
                {rt.boardOffline(b)}
              </p>
            ))}
          </div>
        ) : null}

        {empty ? <p className="text-meta text-muted-foreground">{t.nothingConfigured}</p> : null}
      </div>

      {primary || menuItems.length ? (
        <footer className="mt-auto flex items-center justify-end gap-2 border-t px-3 py-2">
          {primary}
          {menuItems.length ? (
            <DropdownMenu>
              <SimpleTooltip label={t.unitMenu(card.name)}>
                <DropdownMenuTrigger asChild>
                  <Button size="icon-sm" variant="ghost" aria-label={t.unitMenu(card.name)}><EllipsisIcon aria-hidden /></Button>
                </DropdownMenuTrigger>
              </SimpleTooltip>
              <DropdownMenuContent align="end" className="w-56">{menuItems}</DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </footer>
      ) : null}

      {view.kind === "mine" ? (
        <NoteDialog
          open={dialog === "note"}
          onOpenChange={(o) => setDialog(o ? "note" : null)}
          equipmentName={card.name}
          initial={view.note ?? ""}
          pending={actions.pending.reserve}
          onSave={actions.saveNote}
        />
      ) : null}
      {view.kind === "other" && viewer.isAdmin ? (
        <ForceReleaseDialog
          open={dialog === "force"}
          onOpenChange={(o) => setDialog(o ? "force" : null)}
          equipmentName={card.name}
          holderName={view.holderName}
          onConfirm={actions.forceRelease}
          sessions={sessions}
        />
      ) : null}
      {view.kind === "mine" ? releaser.dialog : null}
    </article>
  )
}

/** "2 de 5 accesos abiertos": lamp + text, links to the unit's Accesos tab. */
function AccessesIndicator({ href, accesses }: { href: string; accesses: EquipmentCardDTO["accesses"] }) {
  const open = accesses.filter((a) => a.runtime.status === "listening").length
  const problem = accesses.some((a) => ["error", "port-busy", "hw-server-missing"].includes(a.runtime.status))
  return (
    <AppLink href={href} className="inline-flex min-w-0 items-center gap-1.5 self-start rounded-sm text-meta text-muted-foreground hover:text-foreground">
      <NetworkIcon aria-hidden className={cn("size-3.5 shrink-0", problem ? "text-danger" : open ? "text-ok" : "text-faint-foreground")} />
      <span className="tabular-nums">{accessUi.bancoIndicator(open, accesses.length)}</span>
    </AppLink>
  )
}
