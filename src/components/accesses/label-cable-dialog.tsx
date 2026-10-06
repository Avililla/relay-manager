"use client"

import * as React from "react"
import { CableIcon, CheckIcon, LoaderCircleIcon, TagIcon, UsbIcon, EthernetPortIcon } from "lucide-react"
import { createCableLabel } from "@/actions/cables"
import { FormField } from "@/components/common/form-field"
import { SegmentedControl } from "@/components/common/segmented-control"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { useLiveSerial } from "@/components/wizard/use-live-serial"
import { useAction } from "@/hooks/use-action"
import type { CableKind, CableLabelDTO, JtagSnapshotDTO } from "@/lib/contracts/accesses"
import type { NetAdapterDTO } from "@/lib/contracts/equipnet"
import type { SerialSnapshotDTO } from "@/lib/contracts/serial"
import { adapterIdentity, cableProduct, newArrivals, nextCableName } from "@/lib/accesses/labels"
import { CABLE_KIND_LABEL, cablesUi as t } from "@/lib/i18n/accesses"
import { cn } from "@/lib/client/cn"
import { useLiveCables } from "./use-live-cables"

/** One cable that can be labelled: a JTAG cable (by serial) or a USB-serial adapter (by identity). */
export interface CableCandidate { kind: CableKind; identity: string; title: string; detail: string; labelName: string | null }

export function cableCandidates(kind: CableKind, jtag: JtagSnapshotDTO, serial: SerialSnapshotDTO | null, labels: readonly CableLabelDTO[], net: readonly NetAdapterDTO[] = []): CableCandidate[] {
  const nameOf = (identity: string) => labels.find((l) => l.kind === kind && l.identity === identity)?.name ?? null
  if (kind === "net-adapter") {
    // USB network adapters only (the lab NIC and the built-in ones are not cables).
    return net.filter((a) => a.usb).map((a) => ({
      kind, identity: a.mac, title: cableProduct(a.manufacturer, a.product, a.driver ?? a.ifname),
      detail: `${a.mac} · ${a.ifname}${a.location ? ` · ${t.location(a.location)}` : ""}`, labelName: nameOf(a.mac),
    }))
  }
  if (kind === "jtag") {
    return jtag.cables.flatMap((c) => (c.serial ? [{
      kind, identity: c.serial, title: cableProduct(c.manufacturer, c.product, `${c.vendorId}:${c.productId}`),
      detail: `${c.serial} · ${t.location(c.location)}`, labelName: nameOf(c.serial),
    }] : []))
  }
  return (serial?.adapters ?? []).map((a) => {
    const identity = adapterIdentity(a)
    return { kind, identity, title: a.label, detail: `${a.serial ?? a.vendorId + ":" + a.productId} · ${t.location(a.location)}`, labelName: nameOf(identity) }
  })
}

/** Stable empty values: the live-state hooks reset when their server value changes identity. */
const EMPTY_SERIAL: SerialSnapshotDTO = { scannedAt: "", adapters: [], others: [], hiddenJtag: 0, watcher: { inotify: false, intervalMs: 2000 } }

type Phase = { step: "wait" } | { step: "name"; identity: string } | { step: "done"; name: string }

/**
 * "Etiquetar un cable": plug the cable in and it is detected (the difference with what was connected when the
 * dialog opened); several at once → choose; or pick one already connected without a label. Then its name (the next
 * free "JTAG-NN" / "USB-NN" suggested) and notes; "Etiquetar otro" chains the next one (sticker workflow).
 */
export function LabelCableDialog({ open, onOpenChange, kind: initialKind, jtag, serial, labels, onLabelled, lockKind = false, initialIdentity = null, net = null }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  kind: CableKind
  jtag: JtagSnapshotDTO
  serial: SerialSnapshotDTO | null
  labels: CableLabelDTO[]
  onLabelled?: (label: { kind: CableKind; identity: string; name: string }) => void
  lockKind?: boolean
  /** Open straight on the name step for this (already connected) cable. */
  initialIdentity?: string | null
  /** Network adapters ("Adaptadores de red"): offered as a third kind when given. */
  net?: NetAdapterDTO[] | null
}) {
  const live = useLiveCables(jtag, labels)
  const liveSerial = useLiveSerial(serial ?? EMPTY_SERIAL).snapshot
  const [kind, setKind] = React.useState<CableKind>(initialKind)
  const [phase, setPhase] = React.useState<Phase>({ step: "wait" })
  const [baseline, setBaseline] = React.useState<string[] | null>(null)
  const [name, setName] = React.useState("")
  const [notes, setNotes] = React.useState("")
  const [savedNames, setSavedNames] = React.useState<string[]>([])
  const save = useAction(createCableLabel)
  const nameRef = React.useRef<HTMLInputElement>(null)

  const candidates = cableCandidates(kind, live.jtag, serial ? liveSerial : null, live.labels, net ?? [])
  const ids = candidates.map((c) => c.identity)
  const takenNames = React.useMemo(() => [...live.labels.filter((l) => l.kind === kind).map((l) => l.name), ...savedNames], [live.labels, kind, savedNames])

  // A fresh baseline each time the dialog opens or the kind changes ("what was already connected").
  const idsKey = ids.join("|")
  const [openedFor, setOpenedFor] = React.useState<string | null>(null)
  const openKey = open ? `${kind}:${initialIdentity ?? ""}` : null
  if (openKey !== openedFor) {
    setOpenedFor(openKey)
    if (open) {
      setBaseline(idsKey ? idsKey.split("|") : [])
      setPhase(initialIdentity ? { step: "name", identity: initialIdentity } : { step: "wait" })
      setName(initialIdentity ? nextCableName(kind, [...labels.filter((l) => l.kind === kind).map((l) => l.name), ...savedNames]) : "")
      setNotes("")
    }
  }
  // The kind follows the caller while closed (a picker for JTAG, the Cables tab…).
  if (!open && kind !== initialKind) setKind(initialKind)

  const arrived = baseline ? newArrivals(baseline, ids) : []
  const arrivedCandidates = candidates.filter((c) => arrived.includes(c.identity))
  const unlabelledOld = candidates.filter((c) => !c.labelName && !arrived.includes(c.identity))

  const choose = React.useCallback((identity: string) => {
    setPhase({ step: "name", identity })
    setName(nextCableName(kind, takenNames))
    setNotes("")
    requestAnimationFrame(() => nameRef.current?.select())
  }, [kind, takenNames])

  // Exactly one new unlabelled cable: go straight to its name.
  const autoChosen = React.useRef(new Set<string>())
  const single = phase.step === "wait" && arrivedCandidates.length === 1 && !arrivedCandidates[0].labelName ? arrivedCandidates[0].identity : null
  React.useEffect(() => {
    if (!single || autoChosen.current.has(single)) return
    autoChosen.current.add(single)
    choose(single)
  }, [single, choose])

  const chosen = phase.step === "name" ? candidates.find((c) => c.identity === phase.identity) ?? null : null

  const restart = () => {
    setBaseline(ids)
    setPhase({ step: "wait" })
    setName("")
    setNotes("")
  }

  const submit = async (another: boolean) => {
    if (phase.step !== "name") return
    const r = await save.run({ kind, identity: phase.identity, name: name.trim(), notes: notes.trim() || null })
    if (!r.ok) return
    const label = { kind, identity: phase.identity, name: name.trim() }
    setSavedNames((s) => [...s, label.name])
    onLabelled?.(label)
    if (another) {
      setBaseline([...ids])
      setPhase({ step: "wait" })
    } else {
      setPhase({ step: "done", name: label.name })
    }
  }

  const KindIcon = kind === "jtag" ? CableIcon : kind === "net-adapter" ? EthernetPortIcon : UsbIcon
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><TagIcon aria-hidden className="size-4 text-muted-foreground" />{t.dialogTitle}</DialogTitle>
          <DialogDescription>{t.intro}</DialogDescription>
        </DialogHeader>

        {!lockKind ? (
          <SegmentedControl<CableKind>
            aria-label={t.kindLabel}
            value={kind}
            onChange={(k) => setKind(k)}
            options={[
              { value: "jtag", label: CABLE_KIND_LABEL.jtag, icon: <CableIcon aria-hidden className="size-3.5" /> },
              { value: "serial-adapter", label: CABLE_KIND_LABEL["serial-adapter"], icon: <UsbIcon aria-hidden className="size-3.5" /> },
              ...(net ? [{ value: "net-adapter" as const, label: CABLE_KIND_LABEL["net-adapter"], icon: <EthernetPortIcon aria-hidden className="size-3.5" /> }] : []),
            ]}
          />
        ) : null}

        {phase.step === "wait" ? (
          <div className="flex flex-col gap-4">
            <div role="status" aria-live="polite" className="flex items-start gap-3 rounded-lg border border-dashed border-input px-4 py-4">
              {arrivedCandidates.length ? <KindIcon aria-hidden className="mt-0.5 size-5 shrink-0 text-brand" /> : <LoaderCircleIcon aria-hidden className="mt-0.5 size-5 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none" />}
              <div className="flex min-w-0 flex-col gap-1">
                <p className="text-body font-medium text-foreground">{arrivedCandidates.length > 1 ? t.detectedMany : arrivedCandidates.length ? t.detectedOne : t.waiting}</p>
                {!arrivedCandidates.length ? <p className="text-meta text-muted-foreground">{t.waitingHelp}</p> : null}
              </div>
            </div>
            {arrivedCandidates.length ? <CandidateList items={arrivedCandidates} onChoose={choose} highlight /> : null}
            <div className="flex flex-col gap-2">
              <h3 className="text-meta font-medium text-muted-foreground">{t.orPick}</h3>
              {unlabelledOld.length ? <CandidateList items={unlabelledOld} onChoose={choose} /> : <p className="text-meta text-muted-foreground">{t.noUnlabelled}</p>}
            </div>
          </div>
        ) : null}

        {phase.step === "name" ? (
          <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); void submit(false) }}>
            <div className="flex items-start gap-3 rounded-lg border bg-card px-3 py-2.5">
              <KindIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div className="flex min-w-0 flex-col">
                <span className="text-meta text-muted-foreground">{t.chosen}</span>
                <span className="truncate text-body text-foreground">{chosen?.title ?? phase.identity}</span>
                <span className="truncate font-mono text-data text-muted-foreground">{chosen?.detail ?? phase.identity}</span>
              </div>
              <Button type="button" variant="ghost" size="sm" className="ml-auto" onClick={() => setPhase({ step: "wait" })}>{t.change}</Button>
            </div>
            <FormField label={t.name} name="name" errors={save.fieldErrors} help={t.nameHelp} required>
              <Input ref={nameRef} value={name} maxLength={32} autoComplete="off" spellCheck={false} onChange={(e) => setName(e.target.value)} className="font-mono" />
            </FormField>
            <FormField label={t.notesOptional} name="notes" errors={save.fieldErrors}>
              <Textarea value={notes} rows={2} maxLength={200} onChange={(e) => setNotes(e.target.value)} />
            </FormField>
            {save.fieldErrors.identity ? <p className="text-meta text-danger">{save.fieldErrors.identity.join(" ")}</p> : null}
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>{t.cancel}</Button>
              <Button type="button" variant="outline" disabled={save.pending || !name.trim()} onClick={() => void submit(true)}>{t.saveAnother}</Button>
              <Button type="submit" variant="primary" disabled={save.pending || !name.trim()} aria-busy={save.pending || undefined}>
                {save.pending ? <LoaderCircleIcon aria-hidden className="animate-spin motion-reduce:hidden" /> : <CheckIcon aria-hidden />}
                {t.save}
              </Button>
            </DialogFooter>
          </form>
        ) : null}

        {phase.step === "done" ? (
          <div className="flex flex-col gap-4">
            <p role="status" className="flex items-center gap-2 rounded-lg bg-ok-tint px-3 py-2.5 text-body text-foreground shadow-[inset_2px_0_0_var(--ok)]">
              <CheckIcon aria-hidden className="size-4 shrink-0 text-ok" />{t.savedAs(phase.name)}
            </p>
            <DialogFooter>
              <Button variant="outline" onClick={restart}>{t.another}</Button>
              <Button variant="primary" onClick={() => onOpenChange(false)}>{t.done}</Button>
            </DialogFooter>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function CandidateList({ items, onChoose, highlight = false }: { items: CableCandidate[]; onChoose: (identity: string) => void; highlight?: boolean }) {
  return (
    <ul className="flex flex-col gap-1.5">
      {items.map((c) => (
        <li key={c.identity} className={cn("flex items-center gap-3 rounded-lg border bg-card px-3 py-2", highlight && "border-brand/60 animate-new-row")}>
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-body text-foreground">{c.labelName ? `${c.labelName} · ${c.title}` : c.title}</span>
            <span className="truncate font-mono text-data text-muted-foreground">{c.detail}</span>
          </div>
          {c.labelName ? <span className="text-meta text-muted-foreground">{t.connectedYes}</span> : (
            <Button size="sm" variant={highlight ? "primary" : "outline"} onClick={() => onChoose(c.identity)} aria-label={t.labelThisAria(`${c.title} ${c.detail}`)}>
              <TagIcon aria-hidden />{t.labelThis}
            </Button>
          )}
        </li>
      ))}
    </ul>
  )
}
