"use client"

import * as React from "react"
import * as ProgressPrimitive from "@radix-ui/react-progress"
import { cn } from "@/lib/client/cn"

/** Determinate progress (discovery scans). Pass `aria-label` or `aria-labelledby`. The track is --muted with a
 * --border hairline, so it shows on every surface (on --popover, --secondary would be invisible in dark). */
function Progress({ className, value, max = 100, ...props }: React.ComponentProps<typeof ProgressPrimitive.Root>) {
  const pct = value === null || value === undefined ? 0 : Math.min(100, Math.max(0, (value / max) * 100))
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      value={value}
      max={max}
      className={cn("relative h-1.5 w-full overflow-hidden rounded-full bg-muted shadow-[inset_0_0_0_1px_var(--border)]", className)}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className="h-full w-full origin-left bg-brand transition-transform duration-200 ease-out motion-reduce:transition-none"
        style={{ transform: `scaleX(${pct / 100})`, "--rm-progress": pct / 100 } as React.CSSProperties}
      />
    </ProgressPrimitive.Root>
  )
}

export { Progress }
