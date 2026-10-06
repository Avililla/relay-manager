"use client"

import * as React from "react"
import { LoaderCircleIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { forms, unsaved } from "@/lib/i18n/shell"
import { cn } from "@/lib/client/cn"
import { StatusDot } from "./status-dot"

/**
 * Sticky footer of an editing page (§8.8, Ajustes and Sistema): dirty indicator, optional "Descartar" and the
 * primary save. Pair it with `useUnsavedChanges(dirty)`. Place `FormErrors` right above it.
 */
export function SaveBar({ dirty, pending, onSave, onDiscard, saveLabel = forms.saveBar, disabled, className, children }: {
  dirty: boolean
  pending: boolean
  onSave?: () => void
  onDiscard?: () => void
  saveLabel?: string
  disabled?: boolean
  className?: string
  children?: React.ReactNode
}) {
  return (
    <div
      data-slot="save-bar"
      className={cn(
        "sticky bottom-0 z-10 flex flex-wrap items-center gap-3 border-t bg-background px-4 py-3",
        className,
      )}
    >
      {/* Below 480 px: the indicator on its own row, then Descartar and a full-width save (never a stray wrap). */}
      <span className="mr-auto inline-flex items-center gap-2 text-meta text-muted-foreground max-[480px]:basis-full" aria-live="polite">
        <StatusDot tone={dirty ? "warn" : "faint"} hollow={!dirty} />
        {dirty ? unsaved.dirty : unsaved.clean}
      </span>
      {children}
      {onDiscard ? (
        <Button variant="ghost" size="lg" disabled={!dirty || pending} onClick={onDiscard}>{forms.discard}</Button>
      ) : null}
      <Button
        type={onSave ? "button" : "submit"}
        variant="primary"
        size="lg"
        disabled={!dirty || disabled}
        pending={pending}
        onClick={onSave}
        className="max-[480px]:flex-1"
      >
        {pending ? <LoaderCircleIcon aria-hidden className="animate-spin motion-reduce:hidden" /> : null}
        {pending ? forms.saving : saveLabel}
      </Button>
    </div>
  )
}
