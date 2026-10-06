import * as React from "react"
import { cn } from "@/lib/client/cn"

/** A key cap: "Ctrl", "Alt", "1". Group with KbdGroup for chords. */
function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "inline-flex h-5 min-w-5 items-center justify-center rounded-sm border border-input bg-secondary px-1 font-mono text-micro text-muted-foreground",
        className,
      )}
      {...props}
    />
  )
}

function KbdGroup({ className, ...props }: React.ComponentProps<"span">) {
  return <span data-slot="kbd-group" className={cn("inline-flex items-center gap-0.5", className)} {...props} />
}

export { Kbd, KbdGroup }
