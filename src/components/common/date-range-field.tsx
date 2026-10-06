"use client"

import * as React from "react"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { common } from "@/lib/i18n/shell"
import { cn } from "@/lib/client/cn"

export interface DateRange { from: string | null; to: string | null }

/**
 * Two native `<input type="date">` labelled "Desde" and "Hasta" (§8.8). Values are "YYYY-MM-DD" in the browser's
 * zone; "Hasta" cannot be earlier than "Desde".
 */
export function DateRangeField({ value, onChange, className, invalid }: { value: DateRange; onChange: (v: DateRange) => void; className?: string; invalid?: boolean }) {
  const fromId = React.useId()
  const toId = React.useId()
  return (
    <div className={cn("flex flex-wrap items-end gap-3", className)} role="group">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={fromId}>{common.from}</Label>
        <Input
          id={fromId}
          type="date"
          value={value.from ?? ""}
          max={value.to ?? undefined}
          aria-invalid={invalid || undefined}
          onChange={(e) => onChange({ ...value, from: e.target.value || null })}
          className="w-40 font-mono text-data tabular-nums"
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={toId}>{common.to}</Label>
        <Input
          id={toId}
          type="date"
          value={value.to ?? ""}
          min={value.from ?? undefined}
          aria-invalid={invalid || undefined}
          onChange={(e) => onChange({ ...value, to: e.target.value || null })}
          className="w-40 font-mono text-data tabular-nums"
        />
      </div>
    </div>
  )
}
