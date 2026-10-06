"use client"

import * as React from "react"
import { LoaderCircleIcon } from "lucide-react"
import { FormField } from "@/components/common/form-field"
import { ConfirmDialog } from "@/components/common/confirm-dialog"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { common } from "@/lib/i18n/shell"
import { reservation as t } from "@/lib/i18n/banco"
import { sessionText } from "@/lib/i18n/accesses"
import type { RemoteSession } from "@/components/accesses/access-model"
import { RemoteSessionList } from "./remote-sessions"

const NOTE_MAX = 120

/**
 * "Motivo (opcional)" + submit: the content of the "Reservar con motivo" popover and of "Editar motivo".
 * Enter submits; the field is optional (an empty note clears it).
 */
export function NoteForm({ initial = "", submitLabel, pending, onSubmit, autoFocus = true }: {
  initial?: string
  submitLabel: string
  pending: boolean
  onSubmit: (note: string | null) => void
  autoFocus?: boolean
}) {
  const [note, setNote] = React.useState(initial)
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit(note.trim() ? note.trim() : null)
      }}
    >
      <FormField label={t.noteField} help={t.noteHelp}>
        <Input
          value={note}
          maxLength={NOTE_MAX}
          autoComplete="off"
          placeholder={t.notePlaceholder}
          autoFocus={autoFocus}
          onChange={(e) => setNote(e.target.value)}
        />
      </FormField>
      <div className="flex justify-end">
        <Button type="submit" variant="primary" disabled={pending} aria-busy={pending || undefined}>
          {pending ? <LoaderCircleIcon aria-hidden className="animate-spin motion-reduce:hidden" /> : null}
          {submitLabel}
        </Button>
      </div>
    </form>
  )
}

/** "Editar motivo" (§8.9): reserving again renews the reservation and updates the note. */
export function NoteDialog({ open, onOpenChange, equipmentName, initial, pending, onSave }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  equipmentName: string
  initial: string
  pending: boolean
  onSave: (note: string | null) => Promise<boolean>
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t.editNoteTitle}</DialogTitle>
          <DialogDescription>{t.editNoteDescription(equipmentName)}</DialogDescription>
        </DialogHeader>
        {open ? (
          <NoteForm
            initial={initial}
            submitLabel={t.saveNote}
            pending={pending}
            onSubmit={async (note) => {
              if (await onSave(note)) onOpenChange(false)
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

/**
 * "Forzar liberación" (§8.9, admins): mandatory reason and "Reservar para mí a continuación" (default on). The
 * confirm button is the filled danger button; the dialog stays open while the actions run.
 */
export function ForceReleaseDialog({ open, onOpenChange, equipmentName, holderName, onConfirm, sessions = [] }: {
  open: boolean
  /** Remote sessions on the unit's accesses: listed, since the release cuts or restricts them. */
  sessions?: readonly RemoteSession[]
  onOpenChange: (open: boolean) => void
  equipmentName: string
  holderName: string
  onConfirm: (reason: string, thenReserve: boolean) => Promise<{ ok: boolean; fieldErrors?: Record<string, string[]> }>
}) {
  const [reason, setReason] = React.useState("")
  const [error, setError] = React.useState<string[] | null>(null)
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          setReason("")
          setError(null)
        }
        onOpenChange(o)
      }}
      title={t.forceReleaseTitle(equipmentName)}
      description={t.forceReleaseBody(holderName)}
      confirmLabel={t.forceReleaseConfirm}
      cancelLabel={common.cancel}
      checkbox={{ label: t.forceReleaseThenReserve, defaultChecked: true }}
      onConfirm={async ({ checked }) => {
        if (reason.trim().length < 3) {
          setError([t.forceReleaseReasonHelp])
          return false
        }
        const r = await onConfirm(reason, checked)
        if (!r.ok) {
          if (r.fieldErrors?.reason) setError(r.fieldErrors.reason)
          return false
        }
        setReason("")
        setError(null)
        return true
      }}
    >
      {sessions.length ? (
        <div className="flex flex-col gap-1.5">
          <p className="text-meta text-muted-foreground">{sessionText.forceBody}</p>
          <RemoteSessionList sessions={sessions} />
        </div>
      ) : null}
      <FormField label={t.forceReleaseReason} help={error ? undefined : t.forceReleaseReasonHelp} error={error} required>
        <Textarea
          value={reason}
          maxLength={200}
          rows={2}
          autoFocus
          placeholder={t.forceReleaseReasonPlaceholder}
          onChange={(e) => {
            setReason(e.target.value)
            if (error && e.target.value.trim().length >= 3) setError(null)
          }}
        />
      </FormField>
    </ConfirmDialog>
  )
}
