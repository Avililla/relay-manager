import * as React from "react"
import { cn } from "@/lib/client/cn"

/**
 * Panel (was Card): surface-1 with a hairline and an 8 px radius, no shadow (§8.4). Never nest panels;
 * inside a panel group content with Section or hairlines.
 */
function Panel({ className, ...props }: React.ComponentProps<"section">) {
  return <section data-slot="panel" className={cn("flex min-w-0 flex-col rounded-lg border bg-card text-card-foreground", className)} {...props} />
}

function PanelHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="panel-header" className={cn("flex min-h-11 flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-2", className)} {...props} />
}

function PanelTitle({ className, as: Tag = "h2", ...props }: React.ComponentProps<"h2"> & { as?: "h2" | "h3" }) {
  return <Tag data-slot="panel-title" className={cn("mr-auto text-section text-foreground", className)} {...props} />
}

function PanelDescription({ className, ...props }: React.ComponentProps<"p">) {
  return <p data-slot="panel-description" className={cn("text-meta text-muted-foreground", className)} {...props} />
}

function PanelBody({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="panel-body" className={cn("flex flex-col gap-4 p-4", className)} {...props} />
}

function PanelFooter({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="panel-footer" className={cn("flex flex-wrap items-center justify-end gap-2 border-t px-4 py-3", className)} {...props} />
}

export { Panel, PanelBody, PanelDescription, PanelFooter, PanelHeader, PanelTitle }
