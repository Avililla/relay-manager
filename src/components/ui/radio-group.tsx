"use client"

import * as React from "react"
import * as RadioGroupPrimitive from "@radix-ui/react-radio-group"
import { cn } from "@/lib/client/cn"

function RadioGroup({ className, ...props }: React.ComponentProps<typeof RadioGroupPrimitive.Root>) {
  return <RadioGroupPrimitive.Root data-slot="radio-group" className={cn("grid gap-2", className)} {...props} />
}

/** 16 px radio; the ring uses --control-border, the selected dot is brand. */
function RadioGroupItem({ className, ...props }: React.ComponentProps<typeof RadioGroupPrimitive.Item>) {
  return (
    <RadioGroupPrimitive.Item
      data-slot="radio-group-item"
      className={cn(
        "peer grid size-4 shrink-0 place-items-center rounded-full border border-control-border bg-muted",
        "data-[state=checked]:border-brand disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-danger",
        className,
      )}
      {...props}
    >
      <RadioGroupPrimitive.Indicator className="block size-2 rounded-full bg-brand" />
    </RadioGroupPrimitive.Item>
  )
}

/** A selectable card for radio choices (template or driver pickers): the whole card is the hit area. */
function RadioCard({ className, children, ...props }: React.ComponentProps<typeof RadioGroupPrimitive.Item>) {
  return (
    <RadioGroupPrimitive.Item
      data-slot="radio-card"
      className={cn(
        "group relative flex w-full flex-col items-start gap-1 rounded-lg border bg-card p-3 text-left tint-transition",
        "hover:border-control-border data-[state=checked]:border-brand data-[state=checked]:bg-brand-tint",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      {children}
    </RadioGroupPrimitive.Item>
  )
}

export { RadioCard, RadioGroup, RadioGroupItem }
