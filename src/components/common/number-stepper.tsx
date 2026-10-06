"use client"

import * as React from "react"
import { MinusIcon, PlusIcon } from "lucide-react"
import { inputClass } from "@/components/ui/input"
import { formatInteger, parseInteger } from "@/lib/i18n/format"
import { common } from "@/lib/i18n/shell"
import { cn } from "@/lib/client/cn"

/**
 * Integer input with − / + buttons (§8.8). Typing is free; the value is clamped to [min, max] on blur and on the
 * buttons. `id` and aria props go to the input (use inside FormField).
 */
export function NumberStepper({ value, onChange, min = 0, max = Number.MAX_SAFE_INTEGER, step = 1, unit, className, disabled, placeholder, title, ...aria }: {
  value: number | null
  onChange: (v: number) => void
  min?: number
  max?: number
  step?: number
  unit?: string
  className?: string
  disabled?: boolean
  placeholder?: string
  title?: string
  id?: string
  name?: string
  "aria-invalid"?: true
  "aria-describedby"?: string
  "aria-label"?: string
}) {
  const [draft, setDraft] = React.useState<string | null>(null)
  const clamp = (n: number) => Math.min(max, Math.max(min, Math.round(n)))
  // es-ES digit grouping ("10.000") like the help texts; typing accepts grouped or plain digits.
  const shown = draft ?? (value === null ? "" : formatInteger(value))
  const commit = (raw: string) => {
    setDraft(null)
    const n = parseInteger(raw)
    if (n !== null) onChange(clamp(n))
  }
  const bump = (d: number) => onChange(clamp((value ?? min) + d))
  return (
    <div className={cn("inline-flex h-8 items-stretch", className)}>
      <button
        type="button"
        disabled={disabled || (value !== null && value <= min)}
        onClick={() => bump(-step)}
        aria-label={common.decrease}
        className="press grid w-8 place-items-center rounded-l-md border border-r-0 border-input bg-secondary text-muted-foreground hover:text-foreground disabled:opacity-50"
      >
        <MinusIcon aria-hidden className="size-3.5" />
      </button>
      <div className="relative min-w-0 flex-1">
        <input
          {...aria}
          type="text"
          inputMode="numeric"
          disabled={disabled}
          placeholder={placeholder}
          title={title}
          value={shown}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowUp") { e.preventDefault(); bump(step) }
            else if (e.key === "ArrowDown") { e.preventDefault(); bump(-step) }
            else if (e.key === "Enter") commit(e.currentTarget.value)
          }}
          className={cn(inputClass, "w-full rounded-none text-center font-mono text-data tabular-nums focus-visible:relative focus-visible:z-[1]", unit && "pr-8")}
        />
        {unit ? <span aria-hidden className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-meta text-muted-foreground">{unit}</span> : null}
      </div>
      <button
        type="button"
        disabled={disabled || (value !== null && value >= max)}
        onClick={() => bump(step)}
        aria-label={common.increase}
        className="press grid w-8 place-items-center rounded-r-md border border-l-0 border-input bg-secondary text-muted-foreground hover:text-foreground disabled:opacity-50"
      >
        <PlusIcon aria-hidden className="size-3.5" />
      </button>
    </div>
  )
}
