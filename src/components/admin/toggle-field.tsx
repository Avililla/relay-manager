"use client"

import * as React from "react"
import { Checkbox } from "@/components/ui/checkbox"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/client/cn"

/**
 * A boolean setting as one row: control, label and an optional description (linked with aria-describedby), plus an
 * optional note under it (for example why the control is locked). `kind="switch"` for settings that apply as a
 * state ("Administrador", "Copia diaria"); `kind="checkbox"` for options of an action ("Debe cambiar la contraseña").
 */
export function ToggleField({ kind = "switch", label, description, note, checked, onCheckedChange, disabled, className }: {
  kind?: "switch" | "checkbox"
  label: React.ReactNode
  description?: React.ReactNode
  note?: React.ReactNode
  checked: boolean
  onCheckedChange: (v: boolean) => void
  disabled?: boolean
  className?: string
}) {
  const id = React.useId()
  const descId = `${id}-desc`
  const noteId = `${id}-note`
  const describedBy = [description ? descId : null, note ? noteId : null].filter(Boolean).join(" ") || undefined
  return (
    <div className={cn("flex items-start gap-3", disabled && "opacity-90", className)}>
      <div className="flex h-5 shrink-0 items-center pt-px">
        {kind === "switch" ? (
          <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} aria-describedby={describedBy} />
        ) : (
          <Checkbox id={id} checked={checked} onCheckedChange={(v) => onCheckedChange(v === true)} disabled={disabled} aria-describedby={describedBy} />
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-0.5">
        <label htmlFor={id} className={cn("text-body font-medium text-foreground", disabled ? "cursor-not-allowed" : "cursor-pointer")}>{label}</label>
        {description ? <p id={descId} className="text-meta text-muted-foreground text-pretty">{description}</p> : null}
        {note ? <div id={noteId} className="pt-1 text-meta text-foreground">{note}</div> : null}
      </div>
    </div>
  )
}
