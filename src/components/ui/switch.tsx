"use client"

import * as React from "react"
import * as SwitchPrimitive from "@radix-ui/react-switch"
import { cn } from "@/lib/client/cn"

/**
 * Switch (data-slot v4 style). Only the thumb moves (transform, 120 ms). `tone="ok"` is for relay state:
 * ON is an --ok fill, OFF is a neutral outline in --control-border (never red, §8.2).
 */
function Switch({ className, tone = "primary", ...props }: React.ComponentProps<typeof SwitchPrimitive.Root> & { tone?: "primary" | "ok" }) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-tone={tone}
      className={cn(
        "peer inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-control-border bg-muted p-px",
        "tint-transition disabled:cursor-not-allowed disabled:opacity-50 aria-busy:cursor-progress",
        "data-[state=checked]:border-primary data-[state=checked]:bg-primary",
        "data-[tone=ok]:data-[state=checked]:border-ok data-[tone=ok]:data-[state=checked]:bg-ok",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          "pointer-events-none block size-4 rounded-full bg-control-border",
          "transition-transform duration-[120ms] ease-out motion-reduce:transition-none",
          "data-[state=checked]:translate-x-4 data-[state=checked]:bg-primary-foreground data-[state=unchecked]:translate-x-0",
          "in-data-[tone=ok]:data-[state=checked]:bg-card",
        )}
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
