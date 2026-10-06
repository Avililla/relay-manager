"use client"

import * as React from "react"
import { ConfirmDialog } from "@/components/common/confirm-dialog"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { workspace as t } from "@/lib/i18n/banco"

export type ReleaseDuration = 15 | 30 | 60 | 240 | null

const DURATIONS: ReadonlyArray<{ value: string; minutes: ReleaseDuration; label: string }> = [
  { value: "15", minutes: 15, label: t.releaseDurations[15] },
  { value: "30", minutes: 30, label: t.releaseDurations[30] },
  { value: "60", minutes: 60, label: t.releaseDurations[60] },
  { value: "240", minutes: 240, label: t.releaseDurations[240] },
  { value: "until", minutes: null, label: t.releaseDurations.until },
]

/**
 * "Soltar puerto…" / "Soltar todos los puertos…" (§8.9): the server closes the port(s) so other tools can use them,
 * for 15 min, 30 min, 1 h, 4 h or until "Retomar puerto". `onConfirm` resolves false to keep the dialog open.
 */
export function ReleasePortDialog({ open, onOpenChange, title, description, confirmLabel, onConfirm }: {
  open: boolean
  onOpenChange: (o: boolean) => void
  title: string
  description: string
  confirmLabel: string
  onConfirm: (minutes: ReleaseDuration) => Promise<boolean>
}) {
  const [value, setValue] = React.useState("30")
  const id = React.useId()
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      tone="primary"
      title={title}
      description={description}
      confirmLabel={confirmLabel}
      onConfirm={() => onConfirm(DURATIONS.find((d) => d.value === value)?.minutes ?? null)}
    >
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-body font-medium text-foreground">{t.releaseDuration}</legend>
        <RadioGroup value={value} onValueChange={setValue} className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {DURATIONS.map((d) => (
            <div key={d.value} className="flex items-center gap-2">
              <RadioGroupItem id={`${id}-${d.value}`} value={d.value} />
              <Label htmlFor={`${id}-${d.value}`} className="font-normal">{d.label}</Label>
            </div>
          ))}
        </RadioGroup>
      </fieldset>
    </ConfirmDialog>
  )
}
