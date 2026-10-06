"use client"

import * as React from "react"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"

export interface SegmentOption<V extends string> { value: V; label: React.ReactNode; icon?: React.ReactNode; disabled?: boolean; ariaLabel?: string }

/**
 * Single-choice segmented control (layout "Columnas / Cuadrícula / Pestañas", date presets). Always has a value:
 * clicking the selected segment keeps it. Outline in --control-border (≥ 3:1).
 */
export function SegmentedControl<V extends string>({ value, onChange, options, size = "md", className, "aria-label": ariaLabel }: {
  value: V
  onChange: (v: V) => void
  options: ReadonlyArray<SegmentOption<V>>
  size?: "sm" | "md"
  className?: string
  "aria-label": string
}) {
  return (
    <ToggleGroup
      type="single"
      size={size}
      value={value}
      onValueChange={(v) => {
        if (v) onChange(v as V)
      }}
      aria-label={ariaLabel}
      className={className}
    >
      {options.map((o) => (
        <ToggleGroupItem key={o.value} value={o.value} disabled={o.disabled} aria-label={o.ariaLabel}>
          {o.icon}
          {o.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}
