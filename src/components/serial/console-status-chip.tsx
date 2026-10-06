"use client"

import * as React from "react"
import { StatusChip } from "@/components/common/status-chip"
import { StatusDot } from "@/components/common/status-dot"
import { SimpleTooltip } from "@/components/ui/tooltip"
import { useStale } from "@/components/providers/events-provider"
import { useServerNow } from "@/components/providers/server-clock-provider"
import type { CaptureState, ConsoleRuntimeDTO } from "@/lib/contracts/serial"
import { useMounted } from "@/hooks/use-mounted"
import { cn } from "@/lib/client/cn"
import { captureView, consoleStatusView, type ConsoleTone } from "./console-status"

const DOT: Record<ConsoleTone, "ok" | "warn" | "danger" | "faint"> = { ok: "ok", warn: "warn", danger: "danger", neutral: "faint" }

/**
 * Console status (§8.6) from its runtime, on the server clock; unlit while the connection is stale. Clock times
 * ("Sin datos desde 12:04") appear once mounted, so the server HTML and the hydration pass always match.
 */
export function useConsoleStatusView(runtime: ConsoleRuntimeDTO) {
  const now = useServerNow()
  const mounted = useMounted()
  const stale = useStale()
  return consoleStatusView(runtime, mounted ? now : undefined, stale, mounted)
}

/** Chip with icon (or lamp) + Spanish label. `quiet` for dense rows. */
export function ConsoleStatusChip({ runtime, quiet = false, className }: { runtime: ConsoleRuntimeDTO; quiet?: boolean; className?: string }) {
  const v = useConsoleStatusView(runtime)
  const tone = v.tone === "neutral" ? "neutral" : v.tone
  if (!v.icon) {
    return (
      <span data-slot="status-chip" className={cn("inline-flex h-6 min-w-0 items-center gap-1.5 rounded-sm text-meta whitespace-nowrap text-foreground", quiet ? "px-0" : tone === "ok" ? "bg-ok-tint px-2 shadow-[inset_2px_0_0_var(--ok)]" : "bg-secondary px-2", className)}>
        <StatusDot tone={DOT[v.tone]} hollow={!v.receiving} />
        <span className="truncate">{v.label}</span>
      </span>
    )
  }
  return (
    <StatusChip tone={tone} icon={v.icon} quiet={quiet} className={className} iconClassName={runtime.status === "opening" ? "animate-spin motion-reduce:animate-none" : undefined}>
      {v.label}
    </StatusChip>
  )
}

/** Capture state badge for the pane toolbar (§8.9). */
export function CaptureStateBadge({ capture, className, compact = false }: { capture: CaptureState; className?: string; compact?: boolean }) {
  const v = captureView(capture)
  const chip = (
    <StatusChip tone={v.tone === "warn" ? "warn" : "neutral"} icon={v.icon} quiet={v.tone !== "warn"} className={cn(v.tone !== "warn" && "text-muted-foreground", className)}>
      <span className={cn(compact && "sr-only")}>{v.label}</span>
    </StatusChip>
  )
  return v.tooltip || compact ? <SimpleTooltip label={v.tooltip ?? v.label}><span className="inline-flex" tabIndex={compact ? 0 : undefined}>{chip}</span></SimpleTooltip> : chip
}
