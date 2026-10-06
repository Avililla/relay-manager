"use client"

import * as React from "react"
import { LoaderCircleIcon } from "lucide-react"
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { common } from "@/lib/i18n/shell"

/**
 * Destructive confirmation (§8.8) on AlertDialog: optional type-to-confirm (the exact name), optional extra
 * checkbox ("Entiendo", "Reservar para mí a continuación") and optional reason field. The confirm button is the
 * only filled danger button in the app. `onConfirm` may be async: the dialog stays open while it runs and closes
 * when it resolves to anything but `false`.
 */
export function ConfirmDialog({
  trigger, open, onOpenChange, title, description, children, confirmLabel, cancelLabel = common.cancel, tone = "danger",
  typeToConfirm, checkbox, requireCheckbox = false, onConfirm, returnFocus,
}: {
  trigger?: React.ReactElement
  open?: boolean
  onOpenChange?: (open: boolean) => void
  title: React.ReactNode
  description?: React.ReactNode
  children?: React.ReactNode
  confirmLabel: string
  cancelLabel?: string
  tone?: "danger" | "primary"
  typeToConfirm?: string
  checkbox?: { label: React.ReactNode; defaultChecked?: boolean }
  requireCheckbox?: boolean
  onConfirm: (ctx: { checked: boolean }) => void | boolean | Promise<void | boolean>
  /** Controlled use without `trigger`: the element that gets focus back on close (Radix would drop it to <body>). */
  returnFocus?: () => HTMLElement | null
}) {
  const [innerOpen, setInnerOpen] = React.useState(false)
  const isOpen = open ?? innerOpen
  const [typed, setTyped] = React.useState("")
  const [checked, setChecked] = React.useState(!!checkbox?.defaultChecked)
  const [busy, setBusy] = React.useState(false)
  const typeId = React.useId()
  const checkId = React.useId()

  const applyOpen = (o: boolean) => {
    if (!o) {
      setTyped("")
      setChecked(!!checkbox?.defaultChecked)
    }
    setInnerOpen(o)
    onOpenChange?.(o)
  }
  const setOpen = (o: boolean) => {
    if (!busy) applyOpen(o)
  }

  const blocked = (typeToConfirm !== undefined && typed.trim() !== typeToConfirm) || (requireCheckbox && !checked)

  return (
    <AlertDialog open={isOpen} onOpenChange={setOpen}>
      {trigger ? <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger> : null}
      <AlertDialogContent returnFocus={returnFocus}>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description ? <AlertDialogDescription>{description}</AlertDialogDescription> : null}
        </AlertDialogHeader>
        {children}
        {typeToConfirm !== undefined ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={typeId}>{common.typeToConfirm(typeToConfirm)}</Label>
            <Input id={typeId} value={typed} autoComplete="off" spellCheck={false} onChange={(e) => setTyped(e.target.value)} />
          </div>
        ) : null}
        {checkbox ? (
          <div className="flex items-center gap-2">
            <Checkbox id={checkId} checked={checked} onCheckedChange={(v) => setChecked(v === true)} />
            <Label htmlFor={checkId} className="font-normal">{checkbox.label}</Label>
          </div>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>{cancelLabel}</AlertDialogCancel>
          <Button
            variant={tone}
            size="lg"
            disabled={blocked}
            pending={busy}
            onClick={async () => {
              setBusy(true)
              try {
                const r = await onConfirm({ checked })
                if (r !== false) applyOpen(false)
              } finally {
                setBusy(false)
              }
            }}
          >
            {busy ? <LoaderCircleIcon aria-hidden className="animate-spin motion-reduce:hidden" /> : null}
            {confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
