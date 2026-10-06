"use client"

import * as React from "react"
import { CopyIcon, EllipsisIcon, Maximize2Icon, Minimize2Icon, SearchIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { SimpleTooltip } from "@/components/ui/tooltip"
import { StatusDot } from "@/components/common/status-dot"
import { TONE_ICON } from "@/components/common/status-chip"
import { CaptureStateBadge, useConsoleStatusView } from "@/components/serial/console-status-chip"
import { isPortProblem } from "@/components/serial/console-status"
import { RxLamp } from "@/components/serial/rx-lamp"
import { useStale } from "@/components/providers/events-provider"
import { lineSummary, type LineSettings, type MatchBy } from "@/lib/contracts/enums"
import type { ConsoleRuntimeDTO } from "@/lib/contracts/serial"
import { serial, terminal as t } from "@/lib/i18n/shell"
import { useElementWidth } from "@/hooks/use-element-width"
import { cn } from "@/lib/client/cn"
import { CaptureMenu, CaptureSubMenu } from "./capture-menu"
import { KeysMenu } from "./keys-menu"
import type { TerminalHandle } from "./terminal"
import { paneToolbarLayout } from "./toolbar-layout"

export { NARROW_PANE_PX } from "./toolbar-layout"

const DOT = { ok: "ok", warn: "warn", danger: "danger", neutral: "faint" } as const

export interface ToolbarConsole {
  id: string
  key: string
  label: string
  line: LineSettings
  adapterShort: string | null
  adapterLabel?: string | null
  matchBy?: MatchBy | null
  byId?: string | null
}

/**
 * 28 px pane toolbar (§8.9): lamp, `KEY · label`, adapter (tooltip: device, by-id, match mode), line summary,
 * capture state; Buscar, Copiar selección, Descargar captura, Teclas, Maximizar and the overflow "⋯"
 * (`overflowItems`: DropdownMenuItems for Soltar/Retomar/Borrar, owned by the workspace). It folds by pane width
 * (`paneToolbarLayout`): below 520 px the actions move into "⋯" and the label goes, then the adapter, the capture
 * state and the line summary, one at a time. Every icon button has an accessible name and a tooltip. The toolbar is
 * the Shift+Tab target when leaving the terminal.
 */
export function TerminalToolbar({ console: c, runtime, terminal, canWrite, maximized, onToggleMaximize, overflowItems, className }: {
  console: ToolbarConsole
  runtime: ConsoleRuntimeDTO
  terminal: React.RefObject<TerminalHandle | null>
  canWrite: boolean
  maximized: boolean
  onToggleMaximize: () => void
  overflowItems?: React.ReactNode
  className?: string
}) {
  const ref = React.useRef<HTMLDivElement>(null)
  const width = useElementWidth(ref)
  const fold = paneToolbarLayout(width, runtime.status)
  const narrow = fold.actionsInMenu
  const v = useConsoleStatusView(runtime)
  const stale = useStale()
  const problem = isPortProblem(runtime.status)
  const Icon = v.icon
  const adapterTip = [
    runtime.devNode ? `${serial.devNode}: ${runtime.devNode}` : null,
    c.byId ? `${serial.byId}: ${c.byId}` : null,
    c.matchBy ? `${serial.matchMode}: ${serial.matchBy[c.matchBy]}` : null,
    c.adapterLabel ?? null,
  ].filter(Boolean)

  const showOverflow = narrow || !!overflowItems
  return (
    <div ref={ref} role="toolbar" aria-label={`${c.key} · ${c.label}`} className={cn("flex h-7 min-w-0 shrink-0 items-center gap-2 border-b bg-card px-2", className)}>
      <SimpleTooltip label={v.label}>
        <span className="inline-flex shrink-0" tabIndex={-1}>
          {Icon && problem ? <Icon aria-hidden className={cn("size-3.5", TONE_ICON[v.tone])} /> : <StatusDot tone={DOT[v.tone]} hollow={!v.receiving && !problem} />}
        </span>
      </SimpleTooltip>
      <span className="sr-only">{v.label}</span>
      <span className="min-w-0 shrink truncate text-meta">
        <span className="font-mono font-semibold text-foreground">{c.key}</span>
        {fold.label ? <span className="text-muted-foreground"> · {c.label}</span> : null}
      </span>
      {fold.adapter ? (
        <SimpleTooltip label={adapterTip.length ? <span className="flex flex-col font-mono text-data">{adapterTip.map((l) => <span key={l as string}>{l}</span>)}</span> : serial.noAdapter}>
          <span tabIndex={0} className="shrink-0 rounded-sm font-mono text-data text-muted-foreground">{c.adapterShort ?? serial.unassignedShort}</span>
        </SimpleTooltip>
      ) : null}
      {fold.line ? <span className="shrink-0 font-mono text-data text-muted-foreground tabular-nums">{lineSummary(c.line)}</span> : null}
      {runtime.status === "open" ? <RxLamp lastRxAt={runtime.lastRxAt} stale={stale} /> : null}
      {fold.capture ? <CaptureStateBadge capture={runtime.capture} compact /> : null}
      <div className="ml-auto flex shrink-0 items-center gap-0.5">
        {!narrow ? (
          <>
            <SimpleTooltip label={t.search}>
              <Button variant="ghost" size="icon-sm" aria-label={t.search} onClick={() => terminal.current?.openSearch()}><SearchIcon aria-hidden /></Button>
            </SimpleTooltip>
            <SimpleTooltip label={t.copySelection}>
              <Button variant="ghost" size="icon-sm" aria-label={t.copySelection} onClick={() => void terminal.current?.copySelection()}><CopyIcon aria-hidden /></Button>
            </SimpleTooltip>
            <CaptureMenu consoleId={c.id} />
          </>
        ) : null}
        <KeysMenu canWrite={canWrite} onSend={(b) => terminal.current?.sendKeys(b)} onBreak={() => terminal.current?.sendBreak()} />
        {!narrow ? (
          <SimpleTooltip label={maximized ? t.restore : t.maximize}>
            <Button variant="ghost" size="icon-sm" aria-label={maximized ? t.restore : t.maximize} aria-pressed={maximized} onClick={onToggleMaximize}>
              {maximized ? <Minimize2Icon aria-hidden /> : <Maximize2Icon aria-hidden />}
            </Button>
          </SimpleTooltip>
        ) : null}
        {showOverflow ? (
          <DropdownMenu>
            <SimpleTooltip label={t.more}>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label={t.more}><EllipsisIcon aria-hidden /></Button>
              </DropdownMenuTrigger>
            </SimpleTooltip>
            <DropdownMenuContent align="end" className="w-60">
              {narrow ? (
                <>
                  <DropdownMenuItem onSelect={() => terminal.current?.openSearch()}><SearchIcon aria-hidden />{t.search}</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => void terminal.current?.copySelection()}><CopyIcon aria-hidden />{t.copySelection}</DropdownMenuItem>
                  <CaptureSubMenu consoleId={c.id} />
                  <DropdownMenuItem onSelect={onToggleMaximize}>
                    {maximized ? <Minimize2Icon aria-hidden /> : <Maximize2Icon aria-hidden />}
                    {maximized ? t.restore : t.maximize}
                  </DropdownMenuItem>
                  {overflowItems ? <DropdownMenuSeparator /> : null}
                </>
              ) : null}
              {overflowItems}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
    </div>
  )
}
