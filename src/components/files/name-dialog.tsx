"use client"

import * as React from "react"
import { FormField } from "@/components/common/form-field"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { validateNewName } from "@/lib/files/names"
import { filesUi as t } from "@/lib/i18n/files"

/**
 * One name field: "Nueva carpeta" and "Cambiar nombre". The name is checked as it is typed (same rules as the
 * server); `onSubmit` returns the field errors of the action, or null when it succeeded (the dialog closes).
 */
export function NameDialog({ open, title, label, submitLabel, initial, field, onClose, onSubmit }: {
  open: boolean
  title: string
  label: string
  submitLabel: string
  initial: string
  field: string
  onClose: () => void
  onSubmit: (name: string) => Promise<Record<string, string[]> | null>
}) {
  const [name, setName] = React.useState(initial)
  const [forOpen, setForOpen] = React.useState<string | null>(null)
  const [serverErrors, setServerErrors] = React.useState<Record<string, string[]>>({})
  const [busy, setBusy] = React.useState(false)
  const inputRef = React.useRef<HTMLInputElement>(null)
  const key = open ? `${title}\u0000${initial}` : null
  if (key !== forOpen) {
    setForOpen(key)
    setName(initial)
    setServerErrors({})
  }
  const local = name === "" ? null : validateNewName(name)
  const errors = local ? { [field]: [local] } : serverErrors
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !busy) onClose() }}>
      <DialogContent
        aria-describedby={undefined}
        onOpenAutoFocus={(e) => {
          // Select the stem ("informe" of "informe.pdf") so typing replaces the name and keeps the extension.
          e.preventDefault()
          const el = inputRef.current
          if (!el) return
          el.focus()
          const dot = initial.lastIndexOf(".")
          el.setSelectionRange(0, dot > 0 ? dot : initial.length)
        }}
      >
        <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={async (e) => {
            e.preventDefault()
            if (local || !name || busy) return
            setBusy(true)
            try {
              const r = await onSubmit(name)
              if (r) setServerErrors(r)
              else onClose()
            } finally {
              setBusy(false)
            }
          }}
        >
          <FormField label={label} name={field} errors={errors} required>
            <Input ref={inputRef} value={name} maxLength={255} spellCheck={false} autoComplete="off" onChange={(e) => { setName(e.target.value); setServerErrors({}) }} />
          </FormField>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>{t.cancelLabel}</Button>
            <Button type="submit" variant="primary" pending={busy} disabled={!name || !!local || name === initial}>{submitLabel}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
