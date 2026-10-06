"use client"

import * as React from "react"
import { NetworkIcon } from "lucide-react"
import { ConfirmDialog } from "@/components/common/confirm-dialog"
import { StatusChip } from "@/components/common/status-chip"
import { SimpleTooltip } from "@/components/ui/tooltip"
import type { RemoteSession } from "@/components/accesses/access-model"
import { sessionText as t } from "@/lib/i18n/accesses"
import { common } from "@/lib/i18n/shell"

/**
 * "2 sesiones remotas": the unit is in use from engineers' PCs (xsdb/Vivado on hw_server, nc/telnet on a console,
 * ssh through the Ethernet forward). The tooltip lists who and from where; they keep the reservation alive.
 */
export function RemoteSessionsChip({ sessions, className }: { sessions: readonly RemoteSession[]; className?: string }) {
  if (!sessions.length) return null
  return (
    <SimpleTooltip
      label={(
        <span className="flex flex-col gap-0.5">
          {sessions.map((s) => <span key={s.id}>{s.text}</span>)}
          <span className="text-faint-foreground">{t.keepsAlive}</span>
        </span>
      )}
    >
      <span tabIndex={0} aria-label={`${t.chipLabel(sessions.length)}: ${sessions.map((s) => s.text).join("; ")}. ${t.keepsAlive}`} className="inline-flex rounded-sm">
        <StatusChip tone="ok" icon={NetworkIcon} className={className}>{t.chip(sessions.length)}</StatusChip>
      </span>
    </SimpleTooltip>
  )
}

/** The sessions and what releasing the reservation does to each ("se cerrará", "pasa a solo lectura"…). */
export function RemoteSessionList({ sessions }: { sessions: readonly RemoteSession[] }) {
  return (
    <ul className="flex flex-col gap-1 rounded-md border bg-secondary/40 px-3 py-2 text-body" data-testid="remote-sessions">
      {sessions.map((s) => (
        <li key={s.id} className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
          <span className="min-w-0 text-foreground">{s.text}</span>
          <span className="text-meta text-muted-foreground">· {t.onRelease[s.onRelease]}</span>
        </li>
      ))}
    </ul>
  )
}

/**
 * "Liberar" with remote sessions open: confirm first, listing them. `requestRelease()` releases at once when there
 * are none.
 */
export function useReleaseWithSessions(sessions: readonly RemoteSession[], equipmentName: string, release: () => Promise<boolean>) {
  const [open, setOpen] = React.useState(false)
  const requestRelease = React.useCallback(() => {
    if (sessions.length) setOpen(true)
    else void release()
  }, [sessions.length, release])
  const dialog = (
    <ConfirmDialog
      open={open}
      onOpenChange={setOpen}
      title={t.releaseTitle(equipmentName)}
      description={t.releaseBody}
      confirmLabel={t.releaseConfirm}
      cancelLabel={common.cancel}
      onConfirm={async () => {
        await release()
      }}
    >
      <RemoteSessionList sessions={sessions} />
    </ConfirmDialog>
  )
  return { requestRelease, dialog }
}
