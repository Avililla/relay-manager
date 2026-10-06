"use client"

import * as React from "react"
import { EyeIcon, EyeOffIcon, TriangleAlertIcon } from "lucide-react"
import { MiddleTruncate } from "@/components/common/middle-truncate"
import { LivePreview } from "@/components/serial/live-preview"
import { MatchByField } from "@/components/serial/match-by-field"
import { PortPicker } from "@/components/serial/port-picker"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { common } from "@/lib/i18n/shell"
import { wizardText as t } from "@/lib/i18n/wizard"
import type { MatchBy } from "@/lib/contracts/enums"
import type { SerialPortDTO, SerialSnapshotDTO } from "@/lib/contracts/serial"
import type { HealthCheckDTO } from "@/lib/contracts/system"
import { defaultMatchBy, findPort, isPreviewable, portName, withDraftHolders } from "@/lib/wizard/ports"

export interface PortChoice { stableKey: string; matchBy: MatchBy; port: SerialPortDTO }

/**
 * "Elegir puerto…" / "Cambiar…" (§8.9 wizard step 3 and Ajustes): the W1-E PortPicker over every port group, the
 * match mode with its warnings, and an optional read-only live preview of the chosen port. Nothing is saved here:
 * the choice goes back to the draft. The preview socket closes with the dialog.
 *
 * `holderOf` lets the list tell the truth about the draft: a port another console of this draft already holds reads
 * "Asignado a este equipo · KEY" instead of "Libre" (it stays selectable, and the summary says who loses it).
 *
 * Focus: the dialog is controlled and has no DialogTrigger, so Radix would drop focus on <body> when it closes.
 * It remembers the element that had focus when it opened and returns there; when that element is gone, it tries
 * the `returnFocus` selectors in order (§8.12).
 */
export function PortChoiceDialog({ open, onOpenChange, title, snapshot, hints, initial, selectable, holderOf, showJtag, onShowJtagChange, baudRate, onConfirm, returnFocus = [] }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  snapshot: SerialSnapshotDTO
  hints: HealthCheckDTO[]
  initial: { stableKey: string | null; matchBy: MatchBy | null }
  selectable: (p: SerialPortDTO) => boolean
  holderOf?: (p: SerialPortDTO) => string | null | undefined
  showJtag: boolean
  onShowJtagChange: (v: boolean) => void
  baudRate: number
  onConfirm: (choice: PortChoice) => void
  returnFocus?: readonly string[]
}) {
  const opener = React.useRef<HTMLElement | null>(null)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-3xl"
        // Runs before Radix moves focus into the dialog: activeElement is still the button that opened it.
        onOpenAutoFocus={() => { opener.current = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null }}
        onCloseAutoFocus={(e) => {
          e.preventDefault()
          const back = opener.current?.isConnected ? opener.current : null
          opener.current = null
          const target = back ?? returnFocus.map((s) => document.querySelector<HTMLElement>(s)).find((el) => !!el && !el.matches(":disabled")) ?? null
          target?.focus()
        }}
      >
        {open ? (
          <PortChoiceBody
            title={title}
            snapshot={snapshot}
            hints={hints}
            initial={initial}
            selectable={selectable}
            holderOf={holderOf}
            showJtag={showJtag}
            onShowJtagChange={onShowJtagChange}
            baudRate={baudRate}
            onCancel={() => onOpenChange(false)}
            onConfirm={(c) => {
              onConfirm(c)
              onOpenChange(false)
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function PortChoiceBody({ title, snapshot, hints, initial, selectable, holderOf, showJtag, onShowJtagChange, baudRate, onCancel, onConfirm }: {
  title: string
  snapshot: SerialSnapshotDTO
  hints: HealthCheckDTO[]
  initial: { stableKey: string | null; matchBy: MatchBy | null }
  selectable: (p: SerialPortDTO) => boolean
  holderOf?: (p: SerialPortDTO) => string | null | undefined
  showJtag: boolean
  onShowJtagChange: (v: boolean) => void
  baudRate: number
  onCancel: () => void
  onConfirm: (choice: PortChoice) => void
}) {
  const [key, setKey] = React.useState<string | null>(initial.stableKey)
  const [matchBy, setMatchBy] = React.useState<MatchBy>(initial.matchBy ?? defaultMatchBy(findPort(snapshot, initial.stableKey)))
  const [preview, setPreview] = React.useState(false)
  const port = findPort(snapshot, key)
  const canPreview = !!port && isPreviewable(port)
  // The picker shows the draft's view of the ports; selection and everything else use the real snapshot.
  const pickerSnapshot = holderOf ? withDraftHolders(snapshot, holderOf, t.thisEquipment) : snapshot
  const pickerSelectable = (p: SerialPortDTO) => selectable(findPort(snapshot, p.stableKey) ?? p)
  const holder = port && port.stableKey !== initial.stableKey ? holderOf?.(port) ?? null : null

  return (
    <>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{t.portDialogDescription}</DialogDescription>
      </DialogHeader>
      <div className="grid min-w-0 gap-5 md:grid-cols-[minmax(0,1fr)_15rem]">
        <PortPicker
          snapshot={pickerSnapshot}
          value={key}
          onChange={(k, p) => {
            setKey(k)
            setMatchBy(k === initial.stableKey && initial.matchBy ? initial.matchBy : defaultMatchBy(p))
          }}
          showJtag={showJtag}
          onShowJtagChange={onShowJtagChange}
          selectable={pickerSelectable}
          hints={hints}
        />
        <div className="flex min-w-0 flex-col gap-4">
          {port ? (
            <>
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="text-micro text-muted-foreground">{t.chosenPort}</span>
                <span className="font-mono text-data font-semibold text-foreground">{portName(port)}</span>
                <MiddleTruncate value={port.byId ?? port.devNode} tail={16} className="text-muted-foreground" />
              </div>
              {holder ? (
                <p className="flex items-start gap-1.5 text-meta text-foreground">
                  <TriangleAlertIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-warn" />
                  {t.portHeldBy(holder)}
                </p>
              ) : null}
              <MatchByField value={matchBy} onChange={setMatchBy} port={port} />
            </>
          ) : (
            <p className="text-meta text-muted-foreground">{t.noPortSelected}</p>
          )}
          {canPreview ? (
            // The label says the state ("Vista previa" / "Ocultar vista previa"), so no aria-pressed on top of it.
            <Button variant="outline" size="sm" className="self-start" onClick={() => setPreview((v) => !v)}>
              {preview ? <EyeOffIcon aria-hidden /> : <EyeIcon aria-hidden />}
              {preview ? t.hidePreview : t.previewPort}
            </Button>
          ) : null}
        </div>
      </div>
      {preview && port && canPreview ? <LivePreview key={port.stableKey} stableKey={port.stableKey} devNode={port.devNode} baudRate={baudRate} /> : null}
      <DialogFooter>
        <Button variant="ghost" size="lg" onClick={onCancel}>{common.cancel}</Button>
        <Button
          variant="primary"
          size="lg"
          disabled={!port}
          onClick={() => {
            if (port) onConfirm({ stableKey: port.stableKey, matchBy, port })
          }}
        >
          {t.assignPort}
        </Button>
      </DialogFooter>
    </>
  )
}
