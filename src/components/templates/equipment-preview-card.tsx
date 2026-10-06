"use client"

import * as React from "react"
import { PowerIcon, RotateCcwIcon, SlidersHorizontalIcon, ToggleLeftIcon, type LucideIcon } from "lucide-react"
import { ConsoleChannelStrip } from "@/components/serial/console-channel-strip"
import { Tag } from "@/components/ui/tag"
import type { LineSettings, RelayPurpose } from "@/lib/contracts/enums"
import type { ConsoleRuntimeDTO } from "@/lib/contracts/serial"
import { relayPurposeLabel } from "@/lib/i18n/status"
import { templateText } from "@/lib/i18n/wizard"
import { cn } from "@/lib/client/cn"

const PURPOSE_ICON: Record<RelayPurpose, LucideIcon> = { power: PowerIcon, reset: RotateCcwIcon, mode: SlidersHorizontalIcon, generic: ToggleLeftIcon }

/** A console that exists only in a draft: never opened, no adapter yet (or the one the wizard will bind). */
const DRAFT_RUNTIME: ConsoleRuntimeDTO = {
  status: "unbound", devNode: null, detail: null, since: "1970-01-01T00:00:00.000Z", lastRxAt: null, lastLine: null,
  viewers: 0, released: null, capture: "active",
}
/** A console the wizard already gave a port: a plain (hollow) lamp instead of the "no adapter" icon. */
const BOUND_RUNTIME: ConsoleRuntimeDTO = { ...DRAFT_RUNTIME, status: "open" }
/**
 * The strip's runtime parts make no sense for a unit that does not exist yet: the RX lamp and the status tail
 * ("Sin datos", "Sin adaptador asignado", always the row's last span) are hidden, so a row reads KEY, label,
 * port and line. The strips are hidden from assistive technology; an sr-only list says the same in words.
 */
const STATIC_STRIP = "[&_.rx-lamp]:hidden [&>div>span:last-child]:hidden"

export interface PreviewConsole { key: string; label: string; line: LineSettings; adapterShort?: string | null }
/** `target`: the board and channel once chosen. `skipped`: the wizard will not create it (no board channel). */
export interface PreviewRelay { key: string | null; label: string; purpose: RelayPurpose; target?: { boardName: string; channel: number } | null; skipped?: boolean }

/**
 * How a new unit will look on the Banco (template editor, wizard): name, template tag, one channel strip per
 * console (unbound, or with the port the wizard chose) and the relay list when there are relays. Static: the
 * strips carry no live state (no RX lamp, no status text), so nothing here pretends to be receiving data.
 */
export function EquipmentPreviewCard({ name, templateName, consoles, relays, className, caption }: {
  name: string
  templateName: string | null
  consoles: readonly PreviewConsole[]
  relays: readonly PreviewRelay[]
  className?: string
  caption?: React.ReactNode
}) {
  return (
    <figure className={cn("flex min-w-0 flex-col gap-2", className)}>
      <div className="flex min-w-0 flex-col rounded-lg border bg-card">
        <div className="flex min-h-11 flex-wrap items-center gap-x-2 gap-y-1 border-b px-3 py-2">
          <span className="min-w-0 truncate text-body font-semibold text-foreground">{name || "…"}</span>
          {templateName ? <Tag tone="neutral">{templateName}</Tag> : null}
        </div>
        <div className="flex flex-col gap-0.5 px-3 py-2">
          {consoles.length ? (
            <>
              <div aria-hidden className="flex flex-col gap-0.5">
                {consoles.map((c, i) => (
                  <ConsoleChannelStrip
                    key={`${c.key}-${i}`}
                    variant="full"
                    className={STATIC_STRIP}
                    console={{ id: `preview-${i}`, key: c.key || "…", label: c.label, line: c.line, adapterShort: c.adapterShort ?? null, runtime: c.adapterShort ? BOUND_RUNTIME : DRAFT_RUNTIME }}
                  />
                ))}
              </div>
              <ul className="sr-only">
                {consoles.map((c, i) => <li key={`${c.key}-${i}`}>{templateText.previewConsoleSr(c.key || "…", c.adapterShort ?? null)}</li>)}
              </ul>
            </>
          ) : (
            <p className="py-1 text-meta text-faint-foreground">{templateText.previewNoConsoles}</p>
          )}
        </div>
        {relays.length ? (
          <ul className="flex flex-col border-t px-3 py-2">
            {relays.map((r, i) => {
              const Icon = PURPOSE_ICON[r.purpose]
              return (
                <li key={`${r.key ?? "r"}-${i}`} className="flex h-7 min-w-0 items-center gap-2 text-meta">
                  <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 truncate text-foreground">{r.label || r.key}</span>
                  <span className="sr-only">{relayPurposeLabel(r.purpose)}</span>
                  {/* Mono only for the channel number (machine data); board names and placeholders are UI copy (§8.3). */}
                  {r.target ? (
                    <span className="ml-auto flex min-w-0 shrink-0 items-baseline text-meta text-muted-foreground">
                      <span className="max-w-32 truncate">{r.target.boardName}</span>
                      <span aria-hidden> · </span>
                      <span className="sr-only">, canal </span>
                      <span className="font-mono text-data tabular-nums">{r.target.channel}</span>
                    </span>
                  ) : (
                    <span className="ml-auto shrink-0 text-meta text-faint-foreground">{r.skipped ? templateText.previewRelaySkipped : templateText.previewRelayChannel}</span>
                  )}
                </li>
              )
            })}
          </ul>
        ) : null}
      </div>
      {caption ? <figcaption className="text-meta text-muted-foreground">{caption}</figcaption> : null}
    </figure>
  )
}
