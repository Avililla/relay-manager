"use client"

import * as React from "react"
import { CirclePauseIcon } from "lucide-react"
import { StatusDot } from "@/components/common/status-dot"
import { SimpleTooltip } from "@/components/ui/tooltip"
import { lineSummary } from "@/lib/contracts/enums"
import type { ConsoleSummaryDTO } from "@/lib/contracts/equipment"
import { captureStateLabel } from "@/lib/i18n/status"
import { serial } from "@/lib/i18n/shell"
import { cn } from "@/lib/client/cn"
import { TONE_ICON } from "@/components/common/status-chip"
import { useStale } from "@/components/providers/events-provider"
import { useConsoleStatusView } from "./console-status-chip"
import { isPortProblem } from "./console-status"
import { RxLamp } from "./rx-lamp"

type StripConsole = Pick<ConsoleSummaryDTO, "id" | "key" | "label" | "line" | "adapterShort" | "runtime">

const DOT = { ok: "ok", warn: "warn", danger: "danger", neutral: "faint" } as const

/**
 * The signature row (§8): `● UART0  FT4ABCDE·A  115200 8N1  ▮RX  "Starting kernel ..."`.
 * `full` adds the label and the last-line tail; `compact` keeps lamp, KEY, adapter and RX. Problem states replace
 * the tail with icon + Spanish label; a console whose capture is paused shows only the pause icon (§8.9).
 * Machine data is mono; columns drop from the right as the container narrows.
 */
export function ConsoleChannelStrip({ console: c, variant = "full", className }: { console: StripConsole; variant?: "full" | "compact"; className?: string }) {
  const v = useConsoleStatusView(c.runtime)
  const stale = useStale()
  const problem = isPortProblem(c.runtime.status)
  const Icon = v.icon
  return (
    <div data-slot="console-strip" className={cn("@container min-w-0", className)}>
      <div className="flex h-7 min-w-0 items-center gap-2.5 font-mono text-data">
        <SimpleTooltip label={v.label}>
          <span className="inline-flex shrink-0" tabIndex={-1}>
            {Icon && problem ? <Icon aria-hidden className={cn("size-3.5", TONE_ICON[v.tone])} /> : <StatusDot tone={DOT[v.tone]} hollow={!v.receiving && !problem} />}
          </span>
        </SimpleTooltip>
        <span className="sr-only">{`${c.key}: ${v.label}`}</span>
        <span aria-hidden className="shrink-0 font-semibold text-foreground">{c.key}</span>
        {variant === "full" ? <span className="hidden min-w-0 shrink-[3] truncate font-sans text-meta text-muted-foreground @[520px]:inline">{c.label}</span> : null}
        {/* Unbound: the sr-only status above already says "Sin adaptador asignado". */}
        <span aria-hidden={!c.adapterShort || undefined} className={cn("shrink-0 text-muted-foreground", !c.adapterShort && "font-sans text-meta text-faint-foreground")}>{c.adapterShort ?? serial.unassignedShort}</span>
        {variant === "full" ? <span className="hidden shrink-0 text-muted-foreground tabular-nums @[380px]:inline">{lineSummary(c.line)}</span> : null}
        {c.runtime.status === "open" ? <RxLamp lastRxAt={c.runtime.lastRxAt} stale={stale} /> : null}
        {c.runtime.capture === "paused-disk" ? (
          <SimpleTooltip label={captureStateLabel("paused-disk")}>
            <span className="inline-flex shrink-0" tabIndex={-1}>
              <CirclePauseIcon aria-label={captureStateLabel("paused-disk")} className="size-3.5 text-warn" />
            </span>
          </SimpleTooltip>
        ) : null}
        {/* Unbound: the adapter column already says "Sin asignar"; no tail repeating it. */}
        {variant === "full" && c.runtime.status !== "unbound" ? (
          problem || c.runtime.status === "opening" ? (
            <span className="min-w-0 flex-1 truncate font-sans text-meta text-foreground">{v.label}</span>
          ) : c.runtime.lastLine ? (
            <span className="min-w-0 flex-1 truncate text-muted-foreground" title={c.runtime.lastLine}>“{c.runtime.lastLine}”</span>
          ) : (
            <span className="min-w-0 flex-1 truncate font-sans text-meta text-faint-foreground">{v.label}</span>
          )
        ) : null}
      </div>
    </div>
  )
}
