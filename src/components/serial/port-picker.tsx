"use client"

import * as React from "react"
import { CheckIcon } from "lucide-react"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { Tag } from "@/components/ui/tag"
import { StatusChip } from "@/components/common/status-chip"
import { portGroups, type SerialPortDTO, type SerialSnapshotDTO } from "@/lib/contracts/serial"
import type { HealthCheckDTO } from "@/lib/contracts/system"
import { serial } from "@/lib/i18n/shell"
import { cn } from "@/lib/client/cn"
import { hintLabel, portShortName, portStatusView } from "./port-status"
import { SerialHints } from "./serial-hints"

/**
 * Port chooser over `portGroups()` (§8.8): USB adapters grouped by device, then "Puertos virtuales y del sistema".
 * JTAG adapters are hidden unless `showJtag`; "Solo libres" filters busy/assigned ports. A keyboard-accessible
 * listbox (arrows, Home/End, Enter/Space) with `aria-activedescendant`. `selectable(port)` can re-allow ports that
 * belong to the equipment being edited. An empty picker shows `hints` (SerialHints).
 */
export function PortPicker({ snapshot, value, onChange, showJtag = false, onShowJtagChange, selectable, hints, className, "aria-label": ariaLabel = serial.portPicker, id }: {
  snapshot: SerialSnapshotDTO
  value: string | null
  onChange: (stableKey: string, port: SerialPortDTO) => void
  showJtag?: boolean
  onShowJtagChange?: (show: boolean) => void
  selectable?: (port: SerialPortDTO) => boolean
  hints?: HealthCheckDTO[]
  className?: string
  "aria-label"?: string
  id?: string
}) {
  const [onlyFree, setOnlyFree] = React.useState(true)
  const baseId = React.useId()
  const listId = id ?? `${baseId}-list`
  const canPick = React.useCallback((p: SerialPortDTO) => (selectable ? selectable(p) : portStatusView(p).free), [selectable])
  const groups = portGroups(snapshot, { showJtag })
    .map((g) => ({ ...g, ports: onlyFree ? g.ports.filter((p) => canPick(p) || p.stableKey === value) : g.ports }))
    .filter((g) => g.ports.length > 0)
  const options = groups.flatMap((g) => g.ports)
  const enabled = options.filter(canPick)
  const optionId = (key: string) => `${baseId}-opt-${options.findIndex((p) => p.stableKey === key)}`
  const [active, setActive] = React.useState<string | null>(value)
  const activeKey = active && enabled.some((p) => p.stableKey === active) ? active : (value ?? enabled[0]?.stableKey ?? null)
  const jtagCount = snapshot.adapters.filter((a) => a.hints.includes("jtag-probable")).length

  const move = (delta: number | "home" | "end") => {
    if (!enabled.length) return
    const i = enabled.findIndex((p) => p.stableKey === activeKey)
    const next = delta === "home" ? 0 : delta === "end" ? enabled.length - 1 : Math.min(enabled.length - 1, Math.max(0, (i < 0 ? 0 : i) + delta))
    setActive(enabled[next].stableKey)
    document.getElementById(optionId(enabled[next].stableKey))?.scrollIntoView({ block: "nearest" })
  }

  return (
    <div className={cn("flex min-w-0 flex-col gap-2", className)}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex items-center gap-2">
          <Checkbox id={`${baseId}-free`} checked={onlyFree} onCheckedChange={(v) => setOnlyFree(v === true)} />
          <Label htmlFor={`${baseId}-free`} className="font-normal">{serial.onlyFree}</Label>
        </div>
        {onShowJtagChange && (jtagCount > 0 || snapshot.hiddenJtag > 0) ? (
          <div className="flex items-center gap-2">
            <Checkbox id={`${baseId}-jtag`} checked={showJtag} onCheckedChange={(v) => onShowJtagChange(v === true)} />
            <Label htmlFor={`${baseId}-jtag`} className="font-normal">{serial.showJtag(Math.max(jtagCount, snapshot.hiddenJtag))}</Label>
          </div>
        ) : null}
      </div>
      {options.length === 0 ? (
        snapshot.adapters.length + snapshot.others.length === 0 && hints?.length ? (
          <SerialHints checks={hints} />
        ) : (
          <p className="rounded-lg border border-dashed border-input px-4 py-5 text-body text-muted-foreground">{onlyFree ? serial.noPorts : serial.noPortsFilter}</p>
        )
      ) : (
        <div
          id={listId}
          role="listbox"
          tabIndex={0}
          aria-label={ariaLabel}
          aria-activedescendant={activeKey ? optionId(activeKey) : undefined}
          className="max-h-96 overflow-y-auto rounded-lg border bg-card focus-visible:outline-offset-0"
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); move(1) }
            else if (e.key === "ArrowUp") { e.preventDefault(); move(-1) }
            else if (e.key === "Home") { e.preventDefault(); move("home") }
            else if (e.key === "End") { e.preventDefault(); move("end") }
            else if ((e.key === "Enter" || e.key === " ") && activeKey) {
              e.preventDefault()
              const p = enabled.find((x) => x.stableKey === activeKey)
              if (p) onChange(p.stableKey, p)
            }
          }}
        >
          {groups.map((g) => {
            const headId = `${baseId}-g-${g.key}`
            return (
              <div key={g.key} role="group" aria-labelledby={headId} className="border-b last:border-b-0">
                <div id={headId} className="sticky top-0 z-[1] flex flex-wrap items-center gap-2 bg-card px-3 pt-2 pb-1 text-micro text-muted-foreground">
                  <span className="truncate">{g.label}</span>
                  {g.adapter?.hints.map((h) => <Tag key={h} tone="warn">{hintLabel(h)}</Tag>)}
                </div>
                {g.ports.map((p) => {
                  const st = portStatusView(p)
                  const ok = canPick(p)
                  const selected = p.stableKey === value
                  return (
                    <div
                      key={p.stableKey}
                      id={optionId(p.stableKey)}
                      role="option"
                      aria-selected={selected}
                      aria-disabled={!ok || undefined}
                      data-active={p.stableKey === activeKey || undefined}
                      onClick={() => {
                        if (!ok) return
                        setActive(p.stableKey)
                        onChange(p.stableKey, p)
                      }}
                      className={cn(
                        // Below sm the status chip wraps under the path, so the path keeps the width it needs.
                        "grid min-h-9 cursor-default grid-cols-[1rem_2.5rem_minmax(0,1fr)] items-center gap-x-2 gap-y-0.5 px-3 py-1 text-body sm:grid-cols-[1rem_2.5rem_minmax(0,1fr)_auto]",
                        ok ? "hover:bg-secondary" : "opacity-60",
                        "data-[active]:bg-secondary aria-selected:bg-brand-tint",
                      )}
                    >
                      <CheckIcon aria-hidden className={cn("size-4 text-brand", !selected && "invisible")} />
                      <span className="font-mono text-data font-semibold">{portShortName(p)}</span>
                      <PathText path={p.devNode} />
                      <StatusChip tone={st.tone} icon={st.icon} quiet className="max-w-full min-w-0 max-sm:col-start-3">{st.label}</StatusChip>
                    </div>
                  )
                })}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/**
 * A device path truncated in the middle, keeping at least the file name ("/run/user/…/ttyV0"), so narrow rows can
 * still be told apart. Not focusable (it sits inside a listbox option); the option reads the full path.
 */
function PathText({ path }: { path: string }) {
  const base = path.slice(path.lastIndexOf("/") + 1)
  const cut = Math.max(0, path.length - Math.max(12, base.length + 1))
  return (
    <span className="flex min-w-0 font-mono text-data text-muted-foreground">
      <span aria-hidden className="min-w-0 truncate">{path.slice(0, cut)}</span>
      <span aria-hidden className="shrink-0 whitespace-pre">{path.slice(cut)}</span>
      <span className="sr-only">{path}</span>
    </span>
  )
}
