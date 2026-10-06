"use client"

import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/client/cn"
import { InlineAlert } from "./inline-alert"

export type FieldErrors = Record<string, string[]>

/** Errors for a dotted key (`consoles.2.key`, §7.1). */
export function errorsFor(errors: FieldErrors | undefined, key: string): string[] {
  return errors?.[key] ?? []
}

/** Errors for a key and every nested key under it (`consoles.2` also returns `consoles.2.line.baudRate`). */
export function errorsUnder(errors: FieldErrors | undefined, prefix: string): string[] {
  if (!errors) return []
  return Object.entries(errors).filter(([k]) => k === prefix || k.startsWith(`${prefix}.`)).flatMap(([, v]) => v)
}

export interface FieldControlProps {
  id: string
  name?: string
  "aria-invalid"?: true
  "aria-describedby"?: string
  "aria-required"?: true
}

/**
 * Label, control, help and error (§8.8): wires `id`/`htmlFor`, `aria-describedby` and `aria-invalid`. Errors are
 * looked up by the dotted key `name` in `errors` (the `fieldErrors` of useAction), or passed as `error`.
 * `children` is one control element (props are merged into it) or a render function.
 */
export function FormField({ label, name, errors, error, help, required, optionalLabel, className, labelAside, children }: {
  label: React.ReactNode
  name?: string
  errors?: FieldErrors
  error?: string | string[] | null
  help?: React.ReactNode
  required?: boolean
  /** Shown after the label for optional fields, e.g. "(opcional)". */
  optionalLabel?: string
  className?: string
  labelAside?: React.ReactNode
  children: React.ReactElement | ((p: FieldControlProps) => React.ReactNode)
}) {
  const id = React.useId()
  const helpId = `${id}-help`
  const errId = `${id}-error`
  const list = [...(name ? errorsFor(errors, name) : []), ...(error ? (Array.isArray(error) ? error : [error]) : [])]
  const invalid = list.length > 0
  const describedBy = [help ? helpId : null, invalid ? errId : null].filter(Boolean).join(" ") || undefined
  const control: FieldControlProps = {
    id,
    name,
    "aria-invalid": invalid ? true : undefined,
    "aria-describedby": describedBy,
    "aria-required": required ? true : undefined,
  }
  return (
    <div data-slot="form-field" data-invalid={invalid || undefined} className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={id}>
          {label}
          {optionalLabel ? <span className="font-normal text-muted-foreground">{optionalLabel}</span> : null}
        </Label>
        {labelAside}
      </div>
      {typeof children === "function" ? children(control) : <Slot {...control}>{children}</Slot>}
      {help ? <p id={helpId} className="text-meta text-muted-foreground">{help}</p> : null}
      {invalid ? (
        <p id={errId} className="flex flex-col text-meta text-danger">
          {list.map((m, i) => <span key={i}>{m}</span>)}
        </p>
      ) : null}
    </div>
  )
}

/** Form-level errors (`_form`) as an alert above the submit bar (§8.8). */
export function FormErrors({ errors, className }: { errors?: FieldErrors; className?: string }) {
  const list = errorsFor(errors, "_form")
  if (!list.length) return null
  return (
    <InlineAlert tone="danger" role="alert" className={className}>
      {list.length === 1 ? list[0] : <ul className="list-disc pl-4">{list.map((m, i) => <li key={i}>{m}</li>)}</ul>}
    </InlineAlert>
  )
}
