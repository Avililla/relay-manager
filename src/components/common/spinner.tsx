import * as React from "react"
import { LoaderCircleIcon } from "lucide-react"
import { connection } from "@/lib/i18n/shell"
import { cn } from "@/lib/client/cn"

/**
 * Busy indicator. With reduced motion the spinner is replaced by the static text (default "Conectando…", §8.5).
 * `label` is always available to screen readers.
 */
export function Spinner({ label = connection.connecting, showLabel = false, className }: { label?: string; showLabel?: boolean; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-meta text-muted-foreground", className)}>
      <LoaderCircleIcon aria-hidden className="size-4 animate-spin motion-reduce:hidden" />
      <span className={cn(!showLabel && "sr-only motion-reduce:not-sr-only")}>{label}</span>
    </span>
  )
}

/** The "Nuevo" chip for hot-plugged rows: only visible with reduced motion, for 10 s (see `animate-new-row`). */
export function NewRowChip({ label = "Nuevo" }: { label?: string }) {
  return <span className="new-row-chip h-5 items-center rounded-sm bg-brand-tint px-1.5 text-micro text-foreground shadow-[inset_2px_0_0_var(--brand)]">{label}</span>
}
