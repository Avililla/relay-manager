"use client"

import * as React from "react"
import { CheckIcon } from "lucide-react"
import { common } from "@/lib/i18n/shell"
import { cn } from "@/lib/client/cn"

export interface StepDef { id: string; label: string; description?: string }

/**
 * Wizard stepper (§8.9): a vertical list on desktop, a compact bar on mobile (`orientation="horizontal"`).
 * Completed steps can be revisited with `onStepClick`; later steps are not clickable. `aria-current="step"`.
 */
export function Stepper({ steps, current, onStepClick, orientation = "vertical", className, "aria-label": ariaLabel }: {
  steps: StepDef[]
  current: number
  onStepClick?: (index: number) => void
  orientation?: "vertical" | "horizontal"
  className?: string
  "aria-label"?: string
}) {
  if (orientation === "horizontal") {
    const step = steps[current]
    return (
      <nav aria-label={ariaLabel} className={cn("flex flex-col gap-2", className)}>
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-section text-foreground">{step?.label}</span>
          <span className="text-meta text-muted-foreground tabular-nums">{common.step(current + 1, steps.length)}</span>
        </div>
        <ol className="grid gap-1" style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }}>
          {steps.map((s, i) => (
            <li key={s.id} aria-current={i === current ? "step" : undefined} className={cn("h-1 rounded-full", i <= current ? "bg-brand" : "bg-secondary")}>
              <span className="sr-only">{s.label}{i < current ? ` (${common.completed})` : ""}</span>
            </li>
          ))}
        </ol>
      </nav>
    )
  }
  return (
    <nav aria-label={ariaLabel} className={className}>
      <ol className="flex flex-col">
        {steps.map((s, i) => {
          const done = i < current
          const active = i === current
          const clickable = done && !!onStepClick
          const body = (
            <>
              <span
                aria-hidden
                className={cn(
                  "relative z-[1] grid size-6 shrink-0 place-items-center rounded-full border text-micro tabular-nums",
                  done && "border-brand bg-brand-tint text-brand",
                  active && "border-brand bg-background text-foreground ring-2 ring-brand-tint",
                  !done && !active && "border-control-border bg-background text-muted-foreground",
                )}
              >
                {done ? <CheckIcon className="size-3.5" strokeWidth={3} /> : i + 1}
              </span>
              <span className="flex min-w-0 flex-col pt-0.5 text-left">
                <span className={cn("text-body", active ? "font-medium text-foreground" : done ? "text-foreground" : "text-muted-foreground")}>{s.label}</span>
                {s.description ? <span className="text-meta text-muted-foreground">{s.description}</span> : null}
                {done ? <span className="sr-only">({common.completed})</span> : null}
              </span>
            </>
          )
          return (
            <li key={s.id} aria-current={active ? "step" : undefined} className="relative pb-5 last:pb-0">
              {i < steps.length - 1 ? <span aria-hidden className={cn("absolute top-6 bottom-0 left-3 w-px", done ? "bg-brand" : "bg-border")} /> : null}
              {clickable ? (
                <button type="button" onClick={() => onStepClick(i)} className="flex w-full items-start gap-3 rounded-md hover:[&>span:last-child>span:first-child]:underline">
                  {body}
                </button>
              ) : (
                <div className="flex items-start gap-3">{body}</div>
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
