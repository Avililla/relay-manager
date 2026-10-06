"use client"

import * as React from "react"
import { CircleDashedIcon, PlugIcon, Undo2Icon, UnlinkIcon } from "lucide-react"
import { MiddleTruncate } from "@/components/common/middle-truncate"
import { ConsoleStatusChip } from "@/components/serial/console-status-chip"
import { Button } from "@/components/ui/button"
import { Tag } from "@/components/ui/tag"
import type { ConsoleDetailDTO } from "@/lib/contracts/equipment"
import type { ConsoleRuntimeDTO, SerialSnapshotDTO } from "@/lib/contracts/serial"
import { serial as serialText } from "@/lib/i18n/shell"
import { settingsText as t } from "@/lib/i18n/wizard"
import { findPort, portName } from "@/lib/wizard/ports"
import type { SettingsBinding, SettingsConsoleRow } from "@/lib/wizard/settings"

/**
 * The binding cell under a console row in Ajustes (§8.9, `renderRowAside`): the saved port with its live status,
 * or the pending change ("Se asignará al guardar" / "Se desvinculará al guardar"), plus "Cambiar…",
 * "Desvincular" and "Deshacer".
 */
export function ConsoleBindingCell({ row, original, runtime, snapshot, onChange, onChoose }: {
  row: SettingsConsoleRow
  original: ConsoleDetailDTO | null
  runtime: ConsoleRuntimeDTO | null
  snapshot: SerialSnapshotDTO
  onChange: (binding: SettingsBinding) => void
  onChoose: () => void
}) {
  const savedBinding = original?.binding ?? null
  const initial: SettingsBinding = savedBinding ? "keep" : null
  const changed = JSON.stringify(row.binding) !== JSON.stringify(initial)
  const hasPort = row.binding === "keep" ? !!savedBinding : !!row.binding
  const chooseRef = React.useRef<HTMLButtonElement>(null)
  const undoRef = React.useRef<HTMLButtonElement>(null)
  /** "Desvincular" and "Deshacer" remove themselves: focus moves to the control that replaces them in this row (§8.12). */
  const focusAfterCommit = (preferUndo: boolean) => requestAnimationFrame(() => ((preferUndo ? undoRef.current : null) ?? chooseRef.current)?.focus())

  let body: React.ReactNode
  if (row.binding === "keep" && savedBinding) {
    body = (
      <>
        {runtime ? <ConsoleStatusChip runtime={runtime} quiet /> : null}
        <span className="min-w-0 truncate font-mono text-data text-foreground">{savedBinding.adapterLabel ?? original?.adapterShort ?? savedBinding.bindingKey}</span>
        {runtime?.devNode ? <MiddleTruncate value={runtime.devNode} tail={12} className="min-w-0 text-muted-foreground" /> : null}
        <span className="text-meta text-muted-foreground">{t.matchBy(serialText.matchBy[savedBinding.matchBy])}</span>
        {runtime?.status === "missing" ? <span className="basis-full text-meta text-muted-foreground">{t.missingHint}</span> : null}
      </>
    )
  } else if (row.binding && row.binding !== "keep") {
    const port = findPort(snapshot, row.binding.stableKey)
    body = (
      <>
        <PlugIcon aria-hidden className="size-3.5 shrink-0 text-brand" />
        <span className="shrink-0 font-mono text-data text-foreground">{port ? portName(port) : row.binding.stableKey}</span>
        {port ? <MiddleTruncate value={port.byId ?? port.devNode} tail={12} className="min-w-0 text-muted-foreground" /> : null}
        <span className="text-meta text-muted-foreground">{t.matchBy(serialText.matchBy[row.binding.matchBy])}</span>
        <Tag tone="brand">{t.pendingBind}</Tag>
      </>
    )
  } else {
    body = (
      <>
        <CircleDashedIcon aria-hidden className="size-3.5 shrink-0 text-faint-foreground" />
        <span className="text-meta text-faint-foreground">{t.unbound}</span>
        {savedBinding ? <Tag tone="warn">{t.pendingUnbind}</Tag> : null}
      </>
    )
  }

  return (
    <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:gap-x-3">
      <span className="text-micro text-muted-foreground">{t.binding}</span>
      <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2.5 gap-y-1">{body}</span>
      <span className="flex shrink-0 flex-wrap items-center gap-1">
        <Button ref={chooseRef} size="sm" data-binding-choose={row.uid} onClick={onChoose} aria-label={hasPort ? t.changeFor(row.key) : t.assignFor(row.key)}>{hasPort ? t.change : t.assign}</Button>
        {hasPort ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              onChange(null)
              focusAfterCommit(true)
            }}
            aria-label={t.unbindFor(row.key)}
          >
            <UnlinkIcon aria-hidden />
            {t.unbind}
          </Button>
        ) : null}
        {changed ? (
          <Button
            size="sm"
            variant="ghost"
            ref={undoRef}
            onClick={() => {
              onChange(initial)
              focusAfterCommit(false)
            }}
            aria-label={t.undoLabel(row.key)}
          >
            <Undo2Icon aria-hidden />
            {t.keep}
          </Button>
        ) : null}
      </span>
    </div>
  )
}
