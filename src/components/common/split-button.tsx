"use client"

import * as React from "react"
import { ChevronDownIcon, LoaderCircleIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/client/cn"

/**
 * Main action + adjacent chevron (§8.9 "Reservar" / "Reservar con motivo"). The main segment acts immediately;
 * the chevron (`menuLabel` is its accessible name) opens `popover` content. Both halves share one outline.
 */
export function SplitButton({ children, onClick, menuLabel, popover, variant = "primary", size = "md", pending = false, disabled, open, onOpenChange, className }: {
  children: React.ReactNode
  onClick: () => void
  menuLabel: string
  popover: React.ReactNode
  variant?: "primary" | "default"
  size?: "sm" | "md" | "lg"
  pending?: boolean
  disabled?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  className?: string
}) {
  return (
    <div className={cn("inline-flex items-stretch", className)} data-slot="split-button">
      <Button variant={variant} size={size} disabled={disabled || pending} aria-busy={pending || undefined} onClick={onClick} className="rounded-r-none">
        {pending ? <LoaderCircleIcon aria-hidden className="animate-spin motion-reduce:hidden" /> : null}
        {children}
      </Button>
      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverTrigger asChild>
          <Button
            variant={variant}
            size={size}
            disabled={disabled || pending}
            aria-label={menuLabel}
            className={cn("rounded-l-none border-l px-1.5", variant === "primary" ? "border-l-primary-foreground/25" : "border-l-input")}
          >
            <ChevronDownIcon aria-hidden />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-80">{popover}</PopoverContent>
      </Popover>
    </div>
  )
}
