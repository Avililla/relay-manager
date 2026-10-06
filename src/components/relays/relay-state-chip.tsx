"use client"

import * as React from "react"
import type { RelayChannelSummaryDTO } from "@/lib/contracts/equipment"
import { relayPurposeLabel } from "@/lib/i18n/status"
import { relays as t } from "@/lib/i18n/banco"
import { cn } from "@/lib/client/cn"
import { PURPOSE_ICON } from "./relay-icons"
import { relayStateView, type RelayStateView } from "./relay-model"

/** ON (ok fill; a stale ON is an ok tint with foreground text) / OFF (neutral outline) / ? (hatched): the state label is always text, never colour alone (§8.6). */
export function RelayStateBadge({ view, className }: { view: RelayStateView; className?: string }) {
  return (
    <span
      data-state={view.tone}
      data-stale={view.stale || undefined}
      className={cn(
        "inline-flex h-5 min-w-9 shrink-0 items-center justify-center rounded-sm px-1.5 font-mono text-micro tabular-nums",
        view.tone === "on" && (view.stale ? "border border-ok bg-ok-tint text-foreground" : "bg-ok text-card"),
        view.tone === "off" && "border border-control-border text-muted-foreground",
        view.tone === "unknown" && "hatch border border-control-border text-foreground",
        view.stale && "italic",
        className,
      )}
    >
      {/* The "?" sits on a solid chip so the hatch never hides it. */}
      {view.tone === "unknown" ? <span className="rounded-[2px] bg-card px-1 leading-none font-semibold">{view.text}</span> : view.text}
    </span>
  )
}

/**
 * Read-only relay chip for the Banco card (§8.9: actuation only happens in the workspace): purpose icon, label and
 * state; reset relays show no state ("↻ Reinicio").
 */
export function RelayStateChip({ relay: r, stale }: { relay: RelayChannelSummaryDTO; stale: boolean }) {
  const Icon = PURPOSE_ICON[r.purpose]
  const view = relayStateView(r, stale)
  const showState = r.purpose !== "reset"
  return (
    <li className="inline-flex h-6 min-w-0 items-center gap-1.5 rounded-sm bg-secondary pr-1 pl-1.5 text-meta text-foreground">
      <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate" title={relayPurposeLabel(r.purpose)}>{r.label}</span>
      {showState ? (
        <>
          <RelayStateBadge view={view} className="h-4.5 min-w-8" />
          <span className="sr-only">{view.stale ? `, ${t.staleState}` : ""}</span>
        </>
      ) : null}
    </li>
  )
}
