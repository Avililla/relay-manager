"use client"

import * as React from "react"
import * as ToggleGroupPrimitive from "@radix-ui/react-toggle-group"
import { cn } from "@/lib/client/cn"

/** Segmented toggles: outline in --control-border, the pressed item on surface-2 with foreground text. */
function ToggleGroup({ className, size = "md", ...props }: React.ComponentProps<typeof ToggleGroupPrimitive.Root> & { size?: "sm" | "md" }) {
  return (
    <ToggleGroupPrimitive.Root
      data-slot="toggle-group"
      data-size={size}
      className={cn("group/toggle inline-flex items-stretch rounded-md border border-control-border p-0.5", className)}
      {...props}
    />
  )
}

function ToggleGroupItem({ className, ...props }: React.ComponentProps<typeof ToggleGroupPrimitive.Item>) {
  return (
    <ToggleGroupPrimitive.Item
      data-slot="toggle-group-item"
      className={cn(
        "inline-flex items-center justify-center gap-1.5 rounded-sm px-2.5 font-medium whitespace-nowrap text-muted-foreground tint-transition",
        "group-data-[size=md]/toggle:h-7 group-data-[size=md]/toggle:text-body group-data-[size=sm]/toggle:h-6 group-data-[size=sm]/toggle:text-meta",
        "hover:text-foreground data-[state=on]:bg-secondary data-[state=on]:text-foreground focus-visible:outline-offset-0",
        "disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
        className,
      )}
      {...props}
    />
  )
}

export { ToggleGroup, ToggleGroupItem }
