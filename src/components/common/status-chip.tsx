import * as React from "react"
import type { LucideIcon } from "lucide-react"
import { cn } from "@/lib/client/cn"

export type ChipTone = "ok" | "warn" | "danger" | "brand" | "neutral"

const SURFACE: Record<ChipTone, string> = {
  ok: "bg-ok-tint shadow-[inset_2px_0_0_var(--ok)]",
  warn: "bg-warn-tint shadow-[inset_2px_0_0_var(--warn)]",
  danger: "bg-danger-tint shadow-[inset_2px_0_0_var(--danger)]",
  brand: "bg-brand-tint shadow-[inset_2px_0_0_var(--brand)]",
  neutral: "bg-secondary",
}

export const TONE_ICON: Record<ChipTone, string> = {
  ok: "text-ok",
  warn: "text-warn",
  danger: "text-danger",
  brand: "text-brand",
  neutral: "text-faint-foreground",
}

/**
 * Status chip (§8.6): icon + Spanish label + colour, never colour alone. Text stays --foreground on the tint; the
 * status hue is only the icon and the 2 px edge. `quiet` drops the tint for dense rows (icon + text only).
 */
export function StatusChip({ tone, icon: Icon, children, quiet = false, className, title, iconClassName }: {
  tone: ChipTone
  icon?: LucideIcon | null
  children: React.ReactNode
  quiet?: boolean
  className?: string
  title?: string
  iconClassName?: string
}) {
  return (
    <span
      data-slot="status-chip"
      data-tone={tone}
      title={title}
      className={cn(
        "inline-flex h-6 max-w-full min-w-0 items-center gap-1.5 rounded-sm text-meta whitespace-nowrap text-foreground tint-transition",
        quiet ? "px-0" : cn("px-2", SURFACE[tone]),
        className,
      )}
    >
      {Icon ? <Icon aria-hidden className={cn("size-3.5 shrink-0", TONE_ICON[tone], iconClassName)} /> : null}
      <span className="min-w-0 truncate">{children}</span>
    </span>
  )
}
