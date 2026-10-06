import * as React from "react"
import { cn } from "@/lib/client/cn"

/**
 * Page content column: 16 px gutter on mobile, 24 px on desktop (§8.4); wide screens use the width (no narrow
 * canvas). Workspaces do not use it: they fill `main` with `h-full`.
 */
export function Page({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="page" className={cn("mx-auto flex w-full max-w-[1600px] flex-col gap-4 px-4 py-4 md:px-6 md:py-5", className)} {...props} />
}

/**
 * Page title + actions (§8.8). One `h1` per page. Actions wrap under the title on narrow widths.
 * `summary` is a meta line under the title ("12 equipos · 3 reservados").
 */
export function PageHeader({ title, summary, actions, className, children }: {
  title: React.ReactNode
  summary?: React.ReactNode
  actions?: React.ReactNode
  className?: string
  children?: React.ReactNode
}) {
  return (
    <div data-slot="page-header" className={cn("flex flex-wrap items-end justify-between gap-x-4 gap-y-3", className)}>
      <div className="flex min-w-0 flex-col gap-0.5">
        <h1 className="text-title text-foreground">{title}</h1>
        {summary ? <p className="text-meta text-muted-foreground tabular-nums">{summary}</p> : null}
        {children}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  )
}

/**
 * A titled region inside a page or panel: a real `h2` (or `h3`), optional description and actions, then content.
 * Groups with spacing and a hairline instead of nesting panels.
 */
export function Section({ title, description, actions, as: Heading = "h2", className, children, id }: {
  title: React.ReactNode
  description?: React.ReactNode
  actions?: React.ReactNode
  as?: "h2" | "h3"
  className?: string
  children?: React.ReactNode
  id?: string
}) {
  const headingId = React.useId()
  return (
    <section id={id} aria-labelledby={headingId} className={cn("flex flex-col gap-3", className)}>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <Heading id={headingId} className="text-section text-foreground">{title}</Heading>
          {description ? <p className="max-w-[72ch] text-meta text-muted-foreground">{description}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </section>
  )
}
