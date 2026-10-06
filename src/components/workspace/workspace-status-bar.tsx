"use client"

import * as React from "react"
import { Columns3Icon, EyeIcon, LayoutGridIcon, PanelTopIcon } from "lucide-react"
import { SegmentedControl } from "@/components/common/segmented-control"
import { ConnectionIndicator } from "@/components/shell/connection-indicator"
import { Kbd, KbdGroup } from "@/components/ui/kbd"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { SimpleTooltip } from "@/components/ui/tooltip"
import { TERM_FONT, type WorkspaceLayout } from "@/lib/client/prefs"
import { usePreference } from "@/hooks/use-preference"
import { terminal as tt } from "@/lib/i18n/shell"
import { workspace as t } from "@/lib/i18n/banco"
import { cn } from "@/lib/client/cn"
import type { ViewersLine } from "./runtime-merge"

const FONT_SIZES = Array.from({ length: TERM_FONT.max - TERM_FONT.min + 1 }, (_, i) => TERM_FONT.min + i)

/**
 * 28 px status bar (§8.9): live connection, people viewing each console, layout ("Columnas / Cuadrícula /
 * Pestañas") and terminal font size. Below 768 px the layout control is replaced by the forced-tabs note.
 */
export function WorkspaceStatusBar({ id, className, layout, onLayoutChange, layoutForced, viewers, showLayout, aside }: {
  /** Target of the workspace skip link ("Ir a la barra de estado"). */
  id?: string
  className?: string
  layout: WorkspaceLayout
  onLayoutChange: (l: WorkspaceLayout) => void
  layoutForced: boolean
  viewers: ViewersLine[]
  showLayout: boolean
  /** Extra items after the viewers (the "Accesos 2/5" link). */
  aside?: React.ReactNode
}) {
  const [font, setFont] = usePreference("rm-term-font")
  return (
    <div id={id} data-slot="workspace-status-bar" tabIndex={-1} role="group" aria-label={t.statusBar} className={cn("flex h-9 min-w-0 shrink-0 items-center gap-3 border-t bg-card px-2 text-meta text-muted-foreground outline-none md:h-7", className)}>
      <span className="shrink-0 whitespace-nowrap"><ConnectionIndicator className="px-0" /></span>
      {viewers.length ? (
        <SimpleTooltip label={<span className="flex flex-col">{viewers.map((v) => <span key={v.key}>{t.viewersTooltip(v.key, v.names.join(", "))}</span>)}</span>}>
          <span tabIndex={0} className="inline-flex min-w-0 items-center gap-1.5 rounded-sm">
            <EyeIcon aria-hidden className="size-3.5 shrink-0" />
            <span className="sr-only">{t.viewers}: </span>
            <span className="truncate font-mono text-data tabular-nums">{viewers.map((v) => t.viewersOf(v.key, v.count)).join(" · ")}</span>
          </span>
        </SimpleTooltip>
      ) : null}
      {aside}
      <span className="ml-auto hidden shrink-0 items-center gap-1 xl:inline-flex" title={tt.shiftTabHint}>
        <KbdGroup><Kbd className="h-4.5">Mayús</Kbd><Kbd className="h-4.5">Tab</Kbd></KbdGroup>
        <span>{t.leaveTerminal}</span>
      </span>
      <div className="ml-auto flex shrink-0 items-center gap-2 xl:ml-0">
        {showLayout ? (
          layoutForced ? (
            <span className="shrink-0 max-sm:hidden">{t.layoutForced}</span>
          ) : (
            <>
              <span className="shrink-0 max-lg:sr-only">{t.layout}</span>
              <SegmentedControl<WorkspaceLayout>
                size="sm"
                className="p-px [&_[data-slot=toggle-group-item]]:h-5 [&_[data-slot=toggle-group-item]]:px-2"
                aria-label={t.layoutLabel}
                value={layout}
                onChange={onLayoutChange}
                options={[
                  { value: "columns", label: <span className="max-lg:sr-only">{t.layouts.columns}</span>, icon: <Columns3Icon aria-hidden className="size-3.5" />, ariaLabel: t.layouts.columns },
                  { value: "grid", label: <span className="max-lg:sr-only">{t.layouts.grid}</span>, icon: <LayoutGridIcon aria-hidden className="size-3.5" />, ariaLabel: t.layouts.grid },
                  { value: "tabs", label: <span className="max-lg:sr-only">{t.layouts.tabs}</span>, icon: <PanelTopIcon aria-hidden className="size-3.5" />, ariaLabel: t.layouts.tabs },
                ]}
              />
            </>
          )
        ) : null}
        <span className="shrink-0 max-lg:sr-only">{t.fontSize}</span>
        <Select value={String(font)} onValueChange={(v) => setFont(Number(v))}>
          <SelectTrigger size="sm" aria-label={t.fontSizeLabel} className="h-6 w-[5.5rem] font-mono text-meta tabular-nums">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {FONT_SIZES.map((n) => <SelectItem key={n} value={String(n)} className="font-mono tabular-nums">{t.fontPx(n)}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
    </div>
  )
}
