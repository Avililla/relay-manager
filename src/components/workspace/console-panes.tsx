"use client"

import * as React from "react"
import { Panel as ResizablePanel, PanelGroup, PanelResizeHandle } from "react-resizable-panels"
import { ToggleRightIcon } from "lucide-react"
import { StatusDot } from "@/components/common/status-dot"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type { ConsoleStatus } from "@/lib/contracts/enums"
import type { ConsoleDetailDTO } from "@/lib/contracts/equipment"
import { panesKey, panesStorage, type WorkspaceLayout } from "@/lib/client/prefs"
import { isPortProblem } from "@/components/serial/console-status"
import { workspace as t } from "@/lib/i18n/banco"
import { cn } from "@/lib/client/cn"
import { gridRows } from "./layout-model"

const handleClass = cn(
  "group/handle relative flex shrink-0 items-center justify-center rounded-sm outline-none",
  "data-[panel-group-direction=horizontal]:w-2 data-[panel-group-direction=vertical]:h-2",
  "after:rounded-full after:bg-transparent after:content-[''] data-[panel-group-direction=horizontal]:after:h-8 data-[panel-group-direction=horizontal]:after:w-0.5",
  "data-[panel-group-direction=vertical]:after:h-0.5 data-[panel-group-direction=vertical]:after:w-8",
  "hover:after:bg-control-border data-[resize-handle-state=drag]:after:bg-brand focus-visible:after:bg-brand",
)

/** Tab lamp: problems keep their status hue (danger / warn); everything else is a faint hollow lamp. */
function tabDotTone(s: ConsoleStatus): "danger" | "warn" | "faint" {
  if (s === "busy" || s === "released") return "warn"
  if (s === "missing" || s === "no-permission" || s === "error") return "danger"
  return "faint"
}

/**
 * Console layouts (§8.9): "Columnas" (1×N), "Cuadrícula" (2 or 3 columns) and "Pestañas", resizable with
 * react-resizable-panels. Sizes persist per equipment, layout and console count (`rm-panes:<id>:<layout>:<N>`); in
 * the grid every row group shares that key (the library stores each group under its own panel-id set). Every
 * group, panel and handle has an explicit, stable id (see `panesStorage`). Panes keep `min-width: 0`, so the page
 * never overflows and the terminals refit.
 */
export function ConsolePanes({ equipmentId, consoles, layout, gridCols, renderPane, relaysTab, activeTab, onActiveTabChange }: {
  equipmentId: string
  consoles: ConsoleDetailDTO[]
  layout: WorkspaceLayout
  gridCols: number
  renderPane: (c: ConsoleDetailDTO, index: number) => React.ReactNode
  /** Below 768 px the relays become the last tab. */
  relaysTab?: React.ReactNode
  activeTab: string
  onActiveTabChange: (id: string) => void
}) {
  const [storage] = React.useState(() => panesStorage())
  const n = consoles.length
  const gid = panesKey(equipmentId, layout, n)

  if (layout === "tabs") {
    return (
      <Tabs value={activeTab} onValueChange={onActiveTabChange} className="h-full min-h-0 gap-2">
        <TabsList aria-label={t.consolesRegion} className="shrink-0 px-1">
          {consoles.map((c, i) => (
            <TabsTrigger key={c.id} value={c.id} className="font-mono" title={t.focusPane(i + 1, c.key)}>
              <StatusDot tone={tabDotTone(c.runtime.status)} hollow={!isPortProblem(c.runtime.status)} />
              {c.key}
            </TabsTrigger>
          ))}
          {relaysTab ? (
            <TabsTrigger value="relays">
              <ToggleRightIcon aria-hidden />
              {t.tabRelays}
            </TabsTrigger>
          ) : null}
        </TabsList>
        {consoles.map((c, i) => (
          <TabsContent key={c.id} value={c.id} forceMount className="min-h-0 flex-1 data-[state=inactive]:hidden">
            {renderPane(c, i)}
          </TabsContent>
        ))}
        {relaysTab ? (
          <TabsContent value="relays" forceMount className="min-h-0 flex-1 data-[state=inactive]:hidden">
            {relaysTab}
          </TabsContent>
        ) : null}
      </Tabs>
    )
  }

  if (layout === "grid" && n > 1) {
    const rows = gridRows(consoles.map((c, i) => ({ c, i })), gridCols)
    return (
      <PanelGroup id={gid} direction="vertical" autoSaveId={gid} storage={storage} className="min-h-0 min-w-0">
        {rows.map((row, r) => (
          <React.Fragment key={`row-${r}`}>
            {r > 0 ? <PanelResizeHandle id={`${gid}:handle:${r}`} className={handleClass} /> : null}
            <ResizablePanel id={`${equipmentId}-row-${r}`} order={r + 1} minSize={12} className="min-h-0 min-w-0">
              <PanelGroup id={`${gid}:row:${r}`} direction="horizontal" autoSaveId={gid} storage={storage} className="min-h-0 min-w-0">
                {row.map(({ c, i }, k) => (
                  <React.Fragment key={c.id}>
                    {k > 0 ? <PanelResizeHandle id={`${gid}:row:${r}:handle:${k}`} className={handleClass} /> : null}
                    <ResizablePanel id={c.id} order={k + 1} minSize={15} className="min-h-0 min-w-0">
                      {renderPane(c, i)}
                    </ResizablePanel>
                  </React.Fragment>
                ))}
              </PanelGroup>
            </ResizablePanel>
          </React.Fragment>
        ))}
      </PanelGroup>
    )
  }

  return (
    <PanelGroup id={gid} direction="horizontal" autoSaveId={gid} storage={storage} className="min-h-0 min-w-0">
      {consoles.map((c, i) => (
        <React.Fragment key={c.id}>
          {i > 0 ? <PanelResizeHandle id={`${gid}:handle:${i}`} className={handleClass} /> : null}
          <ResizablePanel id={c.id} order={i + 1} minSize={Math.min(15, Math.floor(100 / n))} className="min-h-0 min-w-0">
            {renderPane(c, i)}
          </ResizablePanel>
        </React.Fragment>
      ))}
    </PanelGroup>
  )
}
