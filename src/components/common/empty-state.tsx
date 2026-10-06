import * as React from "react"
import type { LucideIcon } from "lucide-react"
import { cn } from "@/lib/client/cn"

/**
 * Teaching empty state (§8.9): what this place is for, how to fill it, and the action that does it.
 * Left-aligned inside its panel; no illustration.
 */
export function EmptyState({ icon: Icon, title, children, actions, className }: {
  icon?: LucideIcon
  title: React.ReactNode
  children?: React.ReactNode
  actions?: React.ReactNode
  className?: string
}) {
  return (
    <div data-slot="empty-state" className={cn("flex flex-col items-start gap-3 rounded-lg border border-dashed border-input px-5 py-6", className)}>
      {Icon ? (
        <span aria-hidden className="grid size-9 place-items-center rounded-md bg-secondary text-muted-foreground">
          <Icon className="size-4.5" />
        </span>
      ) : null}
      <div className="flex max-w-[64ch] flex-col gap-1">
        <p className="text-section text-foreground">{title}</p>
        {children ? <div className="text-body text-muted-foreground">{children}</div> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  )
}
