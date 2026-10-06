"use client"

import * as React from "react"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { common } from "@/lib/i18n/shell"

/**
 * Light confirmation anchored to its control (§8.8), e.g. a power relay: "¿Cortar la alimentación de Equipo A #07?".
 * Focus starts on Cancel; Esc or a click outside cancels. For destructive deletions use ConfirmDialog.
 */
export function ConfirmPopover({ trigger, question, confirmLabel, onConfirm, open, onOpenChange, side = "left" }: {
  trigger: React.ReactElement
  question: React.ReactNode
  confirmLabel: string
  onConfirm: () => void
  open?: boolean
  onOpenChange?: (open: boolean) => void
  side?: "top" | "right" | "bottom" | "left"
}) {
  const [inner, setInner] = React.useState(false)
  const isOpen = open ?? inner
  const setOpen = (o: boolean) => {
    setInner(o)
    onOpenChange?.(o)
  }
  const cancelRef = React.useRef<HTMLButtonElement>(null)
  const titleId = React.useId()
  return (
    <Popover open={isOpen} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        side={side}
        role="alertdialog"
        aria-labelledby={titleId}
        className="flex w-64 flex-col gap-3"
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          cancelRef.current?.focus()
        }}
      >
        <p id={titleId} className="text-body text-foreground">{question}</p>
        <div className="flex justify-end gap-2">
          <Button ref={cancelRef} size="sm" onClick={() => setOpen(false)}>{common.cancel}</Button>
          <Button
            size="sm"
            variant="danger"
            onClick={() => {
              setOpen(false)
              onConfirm()
            }}
          >
            {confirmLabel}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
