"use client"

import * as React from "react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import type { ConflictMode } from "@/lib/contracts/files"
import { keepBothName } from "@/lib/files/names"
import { filesUi as t } from "@/lib/i18n/files"

export type ConflictChoice = ConflictMode | "skip"

/**
 * Files to upload whose names already exist in the folder: one question per file ("Reemplazar", "Conservar ambos",
 * "Omitir"), or the same answer for all of them. Resolves with a choice per name; closing it skips them all.
 */
export function ConflictDialog({ names, canReplace = true, onDone }: {
  names: string[] | null
  /** RM_FILES_DELETE=admins: replacing is deleting, so only administrators get «Reemplazar». */
  canReplace?: boolean
  onDone: (choices: Map<string, ConflictChoice>) => void
}) {
  const [index, setIndex] = React.useState(0)
  const [all, setAll] = React.useState(false)
  const [choices, setChoices] = React.useState<Map<string, ConflictChoice>>(() => new Map())
  const [forNames, setForNames] = React.useState<string[] | null>(null)
  const checkId = React.useId()
  if (names !== forNames) {
    setForNames(names)
    setIndex(0)
    setAll(false)
    setChoices(new Map())
  }
  if (!names?.length) return null
  const current = names[Math.min(index, names.length - 1)]
  const rest = names.length - index
  const choose = (c: ConflictChoice) => {
    const next = new Map(choices)
    for (const n of all ? names.slice(index) : [current]) next.set(n, c)
    if (all || index + 1 >= names.length) {
      onDone(next)
      return
    }
    setChoices(next)
    setIndex(index + 1)
  }
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onDone(new Map(names.map((n) => [n, choices.get(n) ?? "skip"]))) }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t.conflictTitle(1, current)}</DialogTitle>
          <DialogDescription>{t.conflictBody(1)} {t.keepBothAs(keepBothName(current, 1))}</DialogDescription>
        </DialogHeader>
        {names.length > 1 ? (
          <p className="text-meta text-muted-foreground tabular-nums">{index + 1} / {names.length}</p>
        ) : null}
        {rest > 1 ? (
          <div className="flex items-center gap-2">
            <Checkbox id={checkId} checked={all} onCheckedChange={(v) => setAll(v === true)} />
            <Label htmlFor={checkId} className="font-normal">{t.applyToAll(rest)}</Label>
          </div>
        ) : null}
        <DialogFooter className="flex-wrap">
          <Button variant="ghost" onClick={() => choose("skip")}>{t.skip}</Button>
          <Button variant={canReplace ? "outline" : "primary"} onClick={() => choose("rename")}>{t.keepBoth}</Button>
          {canReplace ? <Button variant="primary" onClick={() => choose("overwrite")}>{t.replace}</Button> : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
