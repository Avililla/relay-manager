"use client"

import * as React from "react"
import { ChevronRightIcon, CircleAlertIcon, CircleCheckIcon, ShieldAlertIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import type { AuditEventDTO, AuditOutcome } from "@/lib/contracts/audit"
import { auditActionLabel, auditOutcomeLabel } from "@/lib/i18n/audit"
import { audit, common } from "@/lib/i18n/shell"
import { cn } from "@/lib/client/cn"
import { viewerDateTime } from "@/lib/client/local-time"
import { useMounted } from "@/hooks/use-mounted"
import { StatusChip, type ChipTone } from "./status-chip"

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
 * Presentational audit list (§8.8, used by Auditoría and the Equipo "Actividad" tab): local dates, Spanish action
 * labels, outcome chips and an expandable pretty-printed detail. Paging is the caller's: pass `onLoadMore` while
 * there is a next cursor. `showIp` adds the IP column (admins).
 */
export function AuditTable({ events, showIp = false, showEquipment = true, onLoadMore, loadingMore = false, empty, className }: {
  events: AuditEventDTO[]
  showIp?: boolean
  showEquipment?: boolean
  onLoadMore?: () => void
  loadingMore?: boolean
  empty?: React.ReactNode
  className?: string
}) {
  const mounted = useMounted()
  const [open, setOpen] = React.useState<Set<number>>(() => new Set())
  const toggle = (id: number) => setOpen((s) => {
    const n = new Set(s)
    if (n.has(id)) n.delete(id)
    else n.add(id)
    return n
  })
  const cols = 5 + (showEquipment ? 1 : 0) + (showIp ? 1 : 0)
  return (
    <div className={cn("flex min-w-0 flex-col gap-3", className)}>
      <Table containerClassName="rounded-lg border bg-card">
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="w-8 first:rounded-tl-lg"><span className="sr-only">{common.detail}</span></TableHead>
            <TableHead>{audit.when}</TableHead>
            <TableHead>{audit.user}</TableHead>
            <TableHead>{audit.action}</TableHead>
            {showEquipment ? <TableHead>{audit.equipment}</TableHead> : null}
            <TableHead>{audit.target}</TableHead>
            {showIp ? <TableHead>{audit.ip}</TableHead> : null}
            <TableHead className="last:rounded-tr-lg">{audit.result}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {events.length ? events.flatMap((e) => {
            const expanded = open.has(e.id)
            const o = OUTCOME[e.outcome]
            const detailId = `audit-detail-${e.id}`
            const rows = [
              <TableRow key={e.id} data-state={expanded ? "selected" : undefined}>
                <TableCell className="pr-0">
                  {e.detail !== null ? (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-expanded={expanded}
                      aria-controls={detailId}
                      aria-label={expanded ? common.hideDetail : common.showDetail}
                      onClick={() => toggle(e.id)}
                    >
                      <ChevronRightIcon aria-hidden className={cn("transition-transform duration-150 ease-(--ease-out) motion-reduce:transition-none", expanded && "rotate-90")} />
                    </Button>
                  ) : null}
                </TableCell>
                <TableCell className="font-mono text-data whitespace-nowrap tabular-nums">
                  <time dateTime={e.at}>{viewerDateTime(e.at, mounted)}</time>
                </TableCell>
                <TableCell className="max-w-40 truncate">{actorLabel(e)}</TableCell>
                <TableCell className="whitespace-nowrap">{auditActionLabel(e.action)}</TableCell>
                {showEquipment ? <TableCell className="max-w-44 truncate">{e.equipmentName ?? ""}</TableCell> : null}
                <TableCell className="max-w-48 truncate text-muted-foreground">{e.targetName ?? e.targetId ?? ""}</TableCell>
                {showIp ? <TableCell className="font-mono text-data text-muted-foreground">{e.ip ?? ""}</TableCell> : null}
                <TableCell>
                  <StatusChip tone={o.tone} icon={o.icon} quiet={e.outcome === "ok"}>{auditOutcomeLabel(e.outcome)}</StatusChip>
                </TableCell>
              </TableRow>,
            ]
            if (expanded && e.detail !== null) {
              rows.push(
                <TableRow key={`${e.id}-detail`} id={detailId} className="hover:bg-transparent">
                  <TableCell />
                  <TableCell colSpan={cols - 1} className="pb-3">
                    <pre className="max-h-72 overflow-auto rounded-md bg-muted p-3 font-mono text-data whitespace-pre-wrap text-foreground">
                      {JSON.stringify(e.detail, null, 2)}
                    </pre>
                  </TableCell>
                </TableRow>,
              )
            }
            return rows
          }) : (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={cols} className="py-6 text-muted-foreground">{empty ?? audit.empty}</TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
      {onLoadMore ? (
        <div>
          <Button onClick={onLoadMore} disabled={loadingMore} aria-busy={loadingMore || undefined}>
            {loadingMore ? common.loadingMore : common.loadMore}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
