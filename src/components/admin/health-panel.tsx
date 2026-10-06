"use client"

import * as React from "react"
import { CircleCheckIcon, CircleXIcon, InfoIcon, LoaderCircleIcon, RotateCwIcon, TriangleAlertIcon, type LucideIcon } from "lucide-react"
import { runHealthChecks } from "@/actions/system"
import { CopyButton } from "@/components/common/copy-button"
import { StatusChip, type ChipTone } from "@/components/common/status-chip"
import { Button } from "@/components/ui/button"
import { Panel, PanelBody, PanelHeader, PanelTitle } from "@/components/ui/panel"
import { Switch } from "@/components/ui/switch"
import { useAction } from "@/hooks/use-action"
import { useMounted } from "@/hooks/use-mounted"
import type { IsoDate } from "@/lib/contracts/common"
import type { HealthCheckDTO, HealthLevel } from "@/lib/contracts/system"
import { setup as setupText, system as t } from "@/lib/i18n/admin"
import { formatTime } from "@/lib/i18n/format"
import { healthGroupLabel, healthLevelLabel } from "@/lib/i18n/status"
import { cn } from "@/lib/client/cn"
import { groupHealth, healthCounts, hintSegments, onlyHealthIssues, prioritizeHealth } from "./system-model"

const LEVEL: Record<HealthLevel, { tone: ChipTone; icon: LucideIcon }> = {
  ok: { tone: "ok", icon: CircleCheckIcon },
  warn: { tone: "warn", icon: TriangleAlertIcon },
  fail: { tone: "danger", icon: CircleXIcon },
  info: { tone: "neutral", icon: InfoIcon },
}

export function HealthLevelChip({ level, quiet = true }: { level: HealthLevel; quiet?: boolean }) {
  const l = LEVEL[level]
  return <StatusChip tone={l.tone} icon={l.icon} quiet={quiet}>{healthLevelLabel(level)}</StatusChip>
}

/** "Qué hacer": prose in the UI face, shell commands in mono on a sunken well with their own copy button. */
function HealthHint({ hint }: { hint: string }) {
  return (
    <p className="mt-1 text-meta leading-6 text-foreground [overflow-wrap:anywhere]">
      <span className="text-muted-foreground">{t.healthHint}: </span>
      {hintSegments(hint).map((s, i) => s.code ? (
        // One unit that wraps as a whole to the next line (and inside itself when longer than the row), so the copy
        // button always sits next to its command.
        <span key={i} className="mx-0.5 inline-flex max-w-full items-center gap-0.5 rounded-sm border bg-muted py-px pr-px pl-1.5 align-middle">
          <code className="min-w-0 font-mono text-data text-foreground [overflow-wrap:anywhere]">{s.text}</code>
          <CopyButton value={s.text} label={setupText.copyCommand} className="size-6 shrink-0" />
        </span>
      ) : <React.Fragment key={i}>{s.text}</React.Fragment>)}
    </p>
  )
}

function CheckRow({ c }: { c: HealthCheckDTO }) {
  return (
    <li className="grid gap-x-4 gap-y-1 border-b px-4 py-3 last:border-b-0 sm:grid-cols-[8.5rem_minmax(0,1fr)]">
      <div className="pt-px"><HealthLevelChip level={c.level} /></div>
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="text-body font-medium text-foreground">{c.label}</p>
        <p className="text-body text-muted-foreground [overflow-wrap:anywhere]">{c.message}</p>
        {c.hint ? <HealthHint hint={c.hint} /> : null}
      </div>
    </li>
  )
}

/**
 * Sistema > Salud (§8.9): the health checks grouped (Runtime, Datos, Serie, Relés, Red, Reloj, Servicio) with level
 * chips (icon + Spanish label + colour) and hints, plus "Volver a comprobar" (runHealthChecks). Groups and checks are
 * ordered for triage (failures and warnings first) and "Solo avisos y fallos" hides the rest.
 */
export function HealthPanel({ initial, checkedAt }: { initial: HealthCheckDTO[]; checkedAt: IsoDate }) {
  const mounted = useMounted()
  const [latest, setLatest] = React.useState<{ from: HealthCheckDTO[]; checks: HealthCheckDTO[]; at: IsoDate } | null>(null)
  const action = useAction(runHealthChecks)
  // A newer server render (router.refresh) wins over a stale local re-check.
  const view = latest && latest.from === initial ? latest : { checks: initial, at: checkedAt }
  const [onlyIssues, setOnlyIssues] = React.useState(false)
  const filterId = React.useId()
  const counts = healthCounts(view.checks)
  const issues = counts.fail + counts.warn
  // Triage order: groups with failures, then warnings, first; inside each group the worst checks lead.
  const all = prioritizeHealth(groupHealth(view.checks))
  const canFilter = issues > 0 && issues < view.checks.length
  const groups = onlyIssues && canFilter ? onlyHealthIssues(all) : all
  const headline = counts.fail ? t.healthFailing : counts.warn ? t.healthNeedsAttention : t.healthAllGood
  const HeadIcon = LEVEL[counts.fail ? "fail" : counts.warn ? "warn" : "ok"].icon

  return (
    <div className="flex flex-col gap-5">
      <Panel>
        <PanelBody className="flex-row flex-wrap items-center gap-x-4 gap-y-3">
          <HeadIcon aria-hidden className={cn("size-5 shrink-0", counts.fail ? "text-danger" : counts.warn ? "text-warn" : "text-ok")} />
          <div className="mr-auto flex min-w-0 flex-col" role="status">
            <p className="text-section text-foreground">{headline}</p>
            <p className="text-meta text-muted-foreground tabular-nums">
              {t.healthSummary(counts.fail, counts.warn, counts.ok)}
              {mounted ? <> · {t.healthCheckedAt(formatTime(view.at))}</> : null}
            </p>
          </div>
          {canFilter ? (
            <div className="flex items-center gap-2">
              <Switch id={filterId} checked={onlyIssues} onCheckedChange={setOnlyIssues} />
              <label htmlFor={filterId} className="cursor-pointer text-body text-foreground">{t.healthOnlyIssues}</label>
            </div>
          ) : null}
          <Button
            variant="default"
            disabled={action.pending}
            aria-busy={action.pending || undefined}
            onClick={async () => {
              const r = await action.run({})
              if (r.ok) setLatest({ from: initial, checks: r.data, at: new Date().toISOString() })
            }}
          >
            {action.pending ? <LoaderCircleIcon aria-hidden className="animate-spin motion-reduce:hidden" /> : <RotateCwIcon aria-hidden />}
            {action.pending ? t.healthChecking : t.healthRecheck}
          </Button>
        </PanelBody>
      </Panel>

      {groups.length === 0 ? <p className="text-body text-muted-foreground">{t.healthEmpty}</p> : null}
      <div className={cn("grid items-start gap-5 2xl:grid-cols-2", action.pending && "opacity-70")} aria-busy={action.pending || undefined}>
        {groups.map((g) => (
          <Panel key={g.group}>
            <PanelHeader>
              <PanelTitle as="h2">{healthGroupLabel(g.group)}</PanelTitle>
              <span className="text-meta text-muted-foreground tabular-nums">{t.healthGroupCount(g.checks.length)}</span>
              {g.worst !== "ok" && g.worst !== "info" ? <HealthLevelChip level={g.worst} quiet={false} /> : null}
            </PanelHeader>
            <ul>{g.checks.map((c) => <CheckRow key={c.id} c={c} />)}</ul>
          </Panel>
        ))}
      </div>
    </div>
  )
}
