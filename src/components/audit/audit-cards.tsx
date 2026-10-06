"use client"

import * as React from "react"
import { ChevronRightIcon, CircleAlertIcon, CircleCheckIcon, ShieldAlertIcon } from "lucide-react"
import { StatusChip, type ChipTone } from "@/components/common/status-chip"
import { Button } from "@/components/ui/button"
import { useMounted } from "@/hooks/use-mounted"
import type { AuditEventDTO, AuditOutcome } from "@/lib/contracts/audit"
import { auditActionLabel, auditOutcomeLabel } from "@/lib/i18n/audit"
import { auditPage as t } from "@/lib/i18n/hardware"
import { audit, common } from "@/lib/i18n/shell"
import { viewerDateTime } from "@/lib/client/local-time"
import { cn } from "@/lib/client/cn"

// Same outcome treatment as W1-E's AuditTable: "Correcto" stays quiet, exceptions carry the colour.
const OUTCOME: Record<AuditOutcome, { tone: ChipTone; icon: typeof CircleCheckIcon }> = {
  ok: { tone: "neutral", icon: CircleCheckIcon },
  denied: { tone: "warn", icon: ShieldAlertIcon },
  error: { tone: "danger", icon: CircleAlertIcon },
}

function actorLabel(e: AuditEventDTO): string {
  if (e.actorKind === "system") return audit.system
  if (e.actorKind === "cli") return `${audit.cli} (${e.actorName})`
  return e.actorName
}

/**
 * Auditoría below 768 px (§8.9): the seven-column table does not fit a phone, so each event is a card with the
 * action and its outcome first, then date and user, then equipment, target and IP, and the expandable detail.
 * The caller shows it with `md:hidden` next to the table (`max-md:hidden`); paging stays the caller's.
 */
export function AuditCards({ events, empty, className }: {
  events: AuditEventDTO[]
  empty: React.ReactNode
  className?: string
}) {
  const mounted = useMounted()
  const [open, setOpen] = React.useState<ReadonlySet<number>>(() => new Set())
  const toggle = (id: number) => setOpen((s) => {
    const n = new Set(s)
    if (n.has(id)) n.delete(id)
    else n.add(id)
    return n
  })

  if (!events.length) {
    return <div className={cn("rounded-lg border bg-card px-4 py-6 text-meta text-muted-foreground", className)}>{empty}</div>
  }
  return (
    <ul aria-label={t.cardsLabel} className={cn("flex flex-col gap-2", className)}>
      {events.map((e) => {
        const o = OUTCOME[e.outcome]
        const expanded = open.has(e.id)
        const detailId = `audit-card-detail-${e.id}`
        const target = e.targetName ?? e.targetId
        return (
          <li key={e.id} className="flex min-w-0 flex-col gap-2 rounded-lg border bg-card p-3">
            <div className="flex items-start justify-between gap-3">
              <span className="min-w-0 text-body font-medium text-foreground">{auditActionLabel(e.action)}</span>
              <StatusChip tone={o.tone} icon={o.icon} quiet={e.outcome === "ok"} className="shrink-0">{auditOutcomeLabel(e.outcome)}</StatusChip>
            </div>
            <p className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-meta text-muted-foreground">
              <time dateTime={e.at} className="font-mono text-data tabular-nums">{viewerDateTime(e.at, mounted)}</time>
              <span className="min-w-0 break-words text-foreground">{actorLabel(e)}</span>
            </p>
            {e.equipmentName || target || e.ip ? (
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-meta">
                {e.equipmentName ? (<><dt className="text-muted-foreground">{audit.equipment}</dt><dd className="break-words text-foreground">{e.equipmentName}</dd></>) : null}
                {target ? (<><dt className="text-muted-foreground">{audit.target}</dt><dd className="break-words text-muted-foreground">{target}</dd></>) : null}
                {e.ip ? (<><dt className="text-muted-foreground">{audit.ip}</dt><dd className="font-mono text-data text-muted-foreground">{e.ip}</dd></>) : null}
              </dl>
            ) : null}
            {e.detail !== null ? (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  className="-ml-2 w-fit"
                  aria-expanded={expanded}
                  aria-controls={expanded ? detailId : undefined}
                  onClick={() => toggle(e.id)}
                >
                  <ChevronRightIcon aria-hidden className={cn("transition-transform duration-150 ease-(--ease-out) motion-reduce:transition-none", expanded && "rotate-90")} />
                  {expanded ? common.hideDetail : common.showDetail}
                </Button>
                {expanded ? (
                  <pre id={detailId} className="max-h-72 overflow-auto rounded-md bg-muted p-3 font-mono text-data whitespace-pre-wrap break-words text-foreground">
                    {JSON.stringify(e.detail, null, 2)}
                  </pre>
                ) : null}
              </>
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}
