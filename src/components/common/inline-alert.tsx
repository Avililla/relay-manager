import * as React from "react"
import { CircleAlertIcon, CircleCheckIcon, InfoIcon, TriangleAlertIcon, type LucideIcon } from "lucide-react"
import { cn } from "@/lib/client/cn"

export type AlertTone = "info" | "ok" | "warn" | "danger"

const SURFACE: Record<AlertTone, string> = {
  info: "bg-brand-tint shadow-[inset_2px_0_0_var(--brand)]",
  ok: "bg-ok-tint shadow-[inset_2px_0_0_var(--ok)]",
  warn: "bg-warn-tint shadow-[inset_2px_0_0_var(--warn)]",
  danger: "bg-danger-tint shadow-[inset_2px_0_0_var(--danger)]",
}
const ICON: Record<AlertTone, { icon: LucideIcon; color: string }> = {
  info: { icon: InfoIcon, color: "text-brand" },
  ok: { icon: CircleCheckIcon, color: "text-ok" },
  warn: { icon: TriangleAlertIcon, color: "text-warn" },
  danger: { icon: CircleAlertIcon, color: "text-danger" },
}

/**
 * Inline alert (§8.2): tint + 2 px edge, status-coloured icon, --foreground text. Say what happened and what to do.
 * No live role by default (pass `role="alert"` only for errors that appear after a user action).
 */
export function InlineAlert({ tone = "info", title, children, actions, icon, className, role }: {
  tone?: AlertTone
  title?: React.ReactNode
  children?: React.ReactNode
  actions?: React.ReactNode
  icon?: LucideIcon
  className?: string
  role?: "alert" | "status"
}) {
  const Icon = icon ?? ICON[tone].icon
  return (
    <div data-slot="inline-alert" data-tone={tone} role={role} className={cn("flex min-w-0 items-start gap-2.5 rounded-md px-3 py-2.5 text-body text-foreground", SURFACE[tone], className)}>
      <Icon aria-hidden className={cn("mt-0.5 size-4 shrink-0", ICON[tone].color)} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {title ? <p className="font-medium">{title}</p> : null}
        {children ? <div className="text-body text-foreground [&_a]:text-brand [&_a]:underline">{children}</div> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2 self-center">{actions}</div> : null}
    </div>
  )
}
