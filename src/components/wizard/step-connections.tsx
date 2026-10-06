"use client"

import * as React from "react"
import {
  ArrowDownUpIcon, CircleAlertIcon, CircleDashedIcon, EyeIcon, LoaderCircleIcon, EyeOffIcon, ListOrderedIcon, PlugIcon, PlugZapIcon, RefreshCwIcon,
  ScanSearchIcon, ServerIcon, TagIcon, TerminalIcon, TriangleAlertIcon, UsbIcon, XIcon, type LucideIcon,
} from "lucide-react"
import { identifyPorts, rescanSerial } from "@/actions/consoles"
import { AppLink } from "@/components/common/app-link"
import { EmptyState } from "@/components/common/empty-state"
import { errorsFor, errorsUnder, type FieldErrors } from "@/components/common/form-field"
import { InlineAlert } from "@/components/common/inline-alert"
import { MiddleTruncate } from "@/components/common/middle-truncate"
import { NewRowChip } from "@/components/common/spinner"
import { Section } from "@/components/common/page"
import { StatusChip } from "@/components/common/status-chip"
import { BoardChannelPicker } from "@/components/forms/board-channel-picker"
import { LivePreview } from "@/components/serial/live-preview"
import { hintLabel, portStatusView } from "@/components/serial/port-status"
import { SerialHints } from "@/components/serial/serial-hints"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tag } from "@/components/ui/tag"
import { useAction } from "@/hooks/use-action"
import { LabelCableDialog } from "@/components/accesses/label-cable-dialog"
import type { CableLabelDTO, JtagSnapshotDTO } from "@/lib/contracts/accesses"
import { cablesUi } from "@/lib/i18n/accesses"
import type { BoardChoiceDTO } from "@/lib/contracts/relays"
import { portGroups, type PortGroup, type ProbeResultDTO, type SerialPortDTO, type SerialSnapshotDTO } from "@/lib/contracts/serial"
import type { HealthCheckDTO } from "@/lib/contracts/system"
import { serial as serialText } from "@/lib/i18n/shell"
import { consoleStatusLabel, probeStateLabel } from "@/lib/i18n/status"
import { wizardText as t } from "@/lib/i18n/wizard"
import { suggestMapping } from "@/lib/serial/mapping"
import { cn } from "@/lib/client/cn"
import { isRelayTarget, portHolder, takenChannels, type PortBinding, type RelayAssignment, type WizardDraft } from "@/lib/wizard/draft"
import { reorderByHostname } from "@/lib/wizard/hostname-order"
import {
  defaultGroupKey, defaultMatchBy, draftPortHolder, findPort, groupForMapping, hostnamesOf, interfaceList, isFreePort, isPreviewable, lacksUniqueSerial, portName,
  probeTone, type ProbeTone,
} from "@/lib/wizard/ports"
import { dataSelector, focusNextFrame } from "./focus-return"
import { PortChoiceDialog } from "./port-choice-dialog"

const NONE = "__none"
const MAX_PREVIEWS = 8
const PROBE_ICON: Record<ProbeTone, LucideIcon> = { ok: TerminalIcon, neutral: CircleDashedIcon, warn: TriangleAlertIcon, danger: CircleAlertIcon }
const MATCH_TEXT = serialText.matchBy
/** The row's "Elegir puerto…" / "Cambiar…" button, where focus goes back after "Quitar" and after the dialog. */
const PORT_TRIGGER = "data-port-trigger"

export interface ConnectionsState {
  probe: Record<string, ProbeResultDTO>
  selectedGroup: string | null
  previewOn: boolean
  notice: string | null
}

function ProbeChip({ result }: { result: ProbeResultDTO | undefined }) {
  if (!result) return null
  const tone = probeTone(result.state)
  return (
    <StatusChip tone={tone} icon={PROBE_ICON[tone]} quiet title={result.error ?? result.hostname ?? undefined}>
      {probeStateLabel(result.state)}
      {result.hostname ? <span className="ml-1 font-mono text-data text-muted-foreground">{result.hostname}</span> : null}
    </StatusChip>
  )
}

/**
 * Step 3 (§8.9). Left: every console slot with its port and match mode ("Elegir puerto…" opens the PortPicker
 * dialog). Right: the detected port groups (USB adapters, then "Puertos virtuales y del sistema"), with
 * "Asignar en orden", the side-by-side live preview, the passive "Identificar" and "Ordenar según nombre de host".
 * Below: a board channel (or "Omitir este relé") per relay slot.
 */
export function StepConnections({ draft, snapshot, isNew, hints, showJtag, onShowJtagChange, boards, skipInterfaces, state, onState, onAssign, onMapping, onRelayTarget, errors, cables }: {
  draft: WizardDraft
  snapshot: SerialSnapshotDTO
  isNew: (stableKey: string) => boolean
  hints: HealthCheckDTO[]
  showJtag: boolean
  onShowJtagChange: (v: boolean) => void
  boards: BoardChoiceDTO[]
  skipInterfaces: number[]
  state: ConnectionsState
  onState: (patch: Partial<ConnectionsState>) => void
  onAssign: (uid: string, binding: PortBinding | null) => void
  onMapping: (mapping: Array<{ slotIndex: number; stableKey: string | null }>) => void
  onRelayTarget: (uid: string, target: RelayAssignment | null) => void
  errors: FieldErrors
  /** JTAG cables and labels, for "Etiquetar un cable" (the adapter names follow the labels). */
  cables?: { jtag: JtagSnapshotDTO; labels: CableLabelDTO[] }
}) {
  const [labelOpen, setLabelOpen] = React.useState(false)
  const [dialogFor, setDialogFor] = React.useState<string | null>(null)
  /** The slot the dialog was last opened for: still known while the dialog closes, for its focus fallback. */
  const [lastDialogFor, setLastDialogFor] = React.useState<string | null>(null)
  const groups = portGroups(snapshot, { showJtag })
  const selected = groups.find((g) => g.key === state.selectedGroup) ?? groups.find((g) => g.key === defaultGroupKey(groups)) ?? null
  const usedInDraft = new Set(Object.values(draft.bindings).map((b) => b.stableKey))
  const slotOfPort = new Map(draft.consoles.flatMap((c) => (draft.bindings[c.uid] ? [[draft.bindings[c.uid].stableKey, c] as const] : [])))
  const dialogSlot = draft.consoles.find((c) => c.uid === dialogFor) ?? null
  const jtagCount = snapshot.adapters.filter((a) => a.hints.includes("jtag-probable")).length
  const noPortsAtAll = snapshot.adapters.length + snapshot.others.length === 0

  const identify = useAction(identifyPorts)
  const rescan = useAction(rescanSerial, { successMessage: t.rescanDone })

  const baud = draft.consoles[0]?.line.baudRate ?? 115200
  const freeKeysOf = (g: PortGroup) => g.ports.filter((p) => isFreePort(p)).map((p) => p.stableKey)

  const hostOrder = React.useMemo(() => {
    const hostnames = Object.fromEntries(Object.entries(hostnamesOf(state.probe)).filter(([k]) => {
      const p = findPort(snapshot, k)
      return !!p && isFreePort(p)
    }))
    return reorderByHostname(
      draft.consoles.map((c) => ({ hostnameRegex: c.identify.hostnameRegex })),
      draft.consoles.map((c) => draft.bindings[c.uid]?.stableKey ?? null),
      hostnames,
    )
  }, [draft.consoles, draft.bindings, state.probe, snapshot])

  const assignInOrder = (g: PortGroup) => {
    const slots = draft.consoles.map((c) => ({ key: c.key, bound: !!draft.bindings[c.uid] }))
    if (!slots.some((s) => !s.bound)) {
      onState({ notice: t.assignInOrderAllBound })
      return
    }
    const mapping = suggestMapping(slots, groupForMapping(g, usedInDraft), { skipInterfaces, onlyFree: true })
    if (!mapping.length) {
      onState({ notice: t.assignInOrderNone })
      return
    }
    onMapping(mapping)
    const pairs = mapping.map((m) => {
      const p = findPort(snapshot, m.stableKey)
      return t.assignPair(draft.consoles[m.slotIndex].key, p ? portName(p) : m.stableKey)
    }).join(", ")
    onState({ notice: t.assignInOrderDone(pairs) })
  }

  const runIdentify = async (g: PortGroup) => {
    const keys = freeKeysOf(g).slice(0, 16)
    if (!keys.length) return
    const r = await identify.run({ stableKeys: keys, baudRate: baud, listenMs: 3000 })
    if (r.ok) {
      onState({ probe: { ...state.probe, ...Object.fromEntries(r.data.map((x) => [x.stableKey, x])) }, notice: t.identifyDone(r.data.length) })
    }
  }

  const previewPorts = selected ? selected.ports.filter(isPreviewable) : []

  /**
   * A manual choice (port dialog, a port's "Consola" select, "Quitar"). The last notice ("Asignado en orden: …")
   * no longer describes the slots, so it is replaced: by who lost the port when the choice took it from another
   * slot, otherwise by nothing.
   */
  const assignManually = (uid: string, binding: PortBinding | null) => {
    const from = binding ? portHolder(draft, binding.stableKey, uid) : null
    onAssign(uid, binding)
    let notice: string | null = null
    if (binding && from) {
      const p = findPort(snapshot, binding.stableKey)
      notice = t.movedPort(from, p ? portName(p) : binding.stableKey, draft.consoles.find((c) => c.uid === uid)?.key ?? "")
    }
    onState({ notice })
  }
  const openDialog = (uid: string) => {
    setDialogFor(uid)
    setLastDialogFor(uid)
  }

  return (
    <div className="flex flex-col gap-8">
      {!draft.consoles.length ? (
        // No consoles (En blanco, or all removed in step 2): no port tooling; the intro says so, the relays follow.
        !draft.relays.length ? (
          <p className="max-w-[72ch] rounded-lg border border-dashed border-input px-4 py-4 text-body text-muted-foreground">{t.nothingToConnect}</p>
        ) : null
      ) : (
        // An explicit single column below xl: an implicit `auto` track grows to the nowrap command blocks of SerialHints.
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-6 xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
          {/* Left: console slots */}
          <Section as="h3" title={t.slotsColumn} description={t.assignLater} className="min-w-0">
            <ol className="flex flex-col gap-2">
              {draft.consoles.map((c, i) => {
                const b = draft.bindings[c.uid]
                const port = b ? findPort(snapshot, b.stableKey) : null
                const err = [...new Set(errorsUnder(errors, `consoles.${i}.binding`))]
                return (
                  <li key={c.uid} className={cn("flex min-w-0 flex-col gap-1.5 rounded-lg border bg-card px-3 py-2.5", err.length && "border-danger/60")}>
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="font-mono text-data font-semibold text-foreground">{c.key}</span>
                      {c.label && c.label !== c.key ? <span className="min-w-0 truncate text-meta text-muted-foreground">{c.label}</span> : null}
                      <span className="ml-auto flex shrink-0 items-center gap-1">
                        <Button size="sm" data-port-trigger={c.uid} onClick={() => openDialog(c.uid)} aria-label={b ? t.changePortOf(c.key) : t.choosePortFor(c.key)}>{b ? t.changePort : t.choosePort}</Button>
                        {b ? (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={t.removePort(c.key)}
                            onClick={() => {
                              assignManually(c.uid, null)
                              // This button goes away with the port: focus moves to "Elegir puerto para X" in the same row.
                              focusNextFrame(dataSelector(PORT_TRIGGER, c.uid))
                            }}
                          >
                            <XIcon aria-hidden />
                          </Button>
                        ) : null}
                      </span>
                    </div>
                    {b ? (
                      <div className="flex min-w-0 flex-col gap-1">
                        <div className="flex min-w-0 items-center gap-2">
                          {port ? (
                            <>
                              <PlugIcon aria-hidden className="size-3.5 shrink-0 text-brand" />
                              <span className="shrink-0 font-mono text-data text-foreground">{portName(port)}</span>
                              <MiddleTruncate value={port.byId ?? port.devNode} tail={14} className="min-w-0 text-muted-foreground" />
                            </>
                          ) : (
                            // The chosen port was unplugged after it was chosen (§8.6 "Puerto ausente"): the slot keeps it.
                            <StatusChip tone="danger" icon={PlugZapIcon} quiet className="gap-2">{consoleStatusLabel("missing")}</StatusChip>
                          )}
                        </div>
                        {!port ? <p className="pl-5.5 text-meta text-muted-foreground">{t.portGone}</p> : null}
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pl-5.5">
                          <span className="text-meta text-muted-foreground">{t.matchLabel(MATCH_TEXT[b.matchBy])}</span>
                          <ProbeChip result={state.probe[b.stableKey]} />
                        </div>
                        {b.matchBy === "adapter" && lacksUniqueSerial(port) ? (
                          <p className="flex items-start gap-1.5 pl-5.5 text-meta text-foreground"><TriangleAlertIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-warn" />{t.noSerialWarning}</p>
                        ) : null}
                      </div>
                    ) : (
                      <p className="flex items-center gap-2 text-meta text-faint-foreground">
                        <CircleDashedIcon aria-hidden className="size-3.5" />
                        {t.unassigned}
                      </p>
                    )}
                    {err.length ? <p className="text-meta text-danger">{err.join(" ")}</p> : null}
                  </li>
                )
              })}
            </ol>
          </Section>

          {/* Right: detected port groups */}
          <Section
            as="h3"
            className="min-w-0"
            title={t.portsColumn}
            actions={
              <>
                {jtagCount > 0 || snapshot.hiddenJtag > 0 ? (
                  <span className="flex items-center gap-2">
                    <Checkbox id="wizard-jtag" checked={showJtag} onCheckedChange={(v) => onShowJtagChange(v === true)} />
                    <Label htmlFor="wizard-jtag" className="font-normal">{t.showJtag(Math.max(jtagCount, snapshot.hiddenJtag))}</Label>
                  </span>
                ) : null}
                <Button size="sm" variant="ghost" disabled={rescan.pending} onClick={() => void rescan.run({})}>
                  <RefreshCwIcon aria-hidden className={cn(rescan.pending && "animate-spin motion-reduce:animate-none")} />
                  {rescan.pending ? t.rescanning : t.rescan}
                </Button>
                {cables ? (
                  <>
                    <Button size="sm" variant="ghost" onClick={() => setLabelOpen(true)}>
                      <TagIcon aria-hidden />{cablesUi.labelCable}
                    </Button>
                    <LabelCableDialog open={labelOpen} onOpenChange={setLabelOpen} kind="serial-adapter" jtag={cables.jtag} serial={snapshot} labels={cables.labels} />
                  </>
                ) : null}
              </>
            }
          >
            {!groups.length ? (
              // The empty state says what is going on; the permission and driver hints that may explain it follow.
              <div className="flex flex-col gap-3">
                <EmptyState icon={UsbIcon} title={t.noPortsTitle}>{t.noPortsBody}</EmptyState>
                {noPortsAtAll && hints.length ? <SerialHints checks={hints} /> : null}
              </div>
            ) : (
              <div className="flex min-w-0 flex-col gap-3">
                {groups.length > 1 ? (
                  <RadioGroup
                    value={selected?.key ?? ""}
                    onValueChange={(v) => onState({ selectedGroup: v, previewOn: false, notice: null })}
                    aria-label={t.groupsLabel}
                    className="grid gap-2 sm:grid-cols-2"
                  >
                    {groups.map((g) => {
                      const free = g.ports.filter(isFreePort).length
                      const Icon = g.adapter ? UsbIcon : ServerIcon
                      const id = `wizard-group-${g.key}`
                      return (
                        <label
                          key={g.key}
                          htmlFor={id}
                          className="flex min-w-0 cursor-pointer items-start gap-2.5 rounded-lg border bg-card px-3 py-2.5 tint-transition hover:border-control-border has-[[data-state=checked]]:border-brand has-[[data-state=checked]]:bg-brand-tint"
                        >
                          <RadioGroupItem id={id} value={g.key} className="mt-0.5" />
                          <span className="flex min-w-0 flex-col gap-0.5">
                            <span className="flex min-w-0 items-start gap-1.5">
                              <Icon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                              <span className="line-clamp-2 min-w-0 text-body font-medium text-foreground">{g.adapter ? g.adapter.label : g.label}</span>
                            </span>
                            <span className="text-meta text-muted-foreground tabular-nums">
                              {g.adapter ? `${g.adapter.location} · ` : ""}{t.groupPorts(g.ports.length, free)}
                            </span>
                            {g.adapter?.hints.length ? (
                              <span className="flex flex-wrap gap-1 pt-0.5">{g.adapter.hints.map((h) => <Tag key={h} tone="warn">{hintLabel(h)}</Tag>)}</span>
                            ) : null}
                          </span>
                        </label>
                      )
                    })}
                  </RadioGroup>
                ) : null}

                {selected ? (
                  <>
                    <section aria-labelledby="wizard-group-title" className="flex min-w-0 flex-col rounded-lg border bg-card">
                      <header className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b px-3 py-2.5">
                        {selected.adapter ? <UsbIcon aria-hidden className="size-4 text-muted-foreground" /> : <ServerIcon aria-hidden className="size-4 text-muted-foreground" />}
                        <h4 id="wizard-group-title" className="min-w-0 text-body font-semibold text-foreground">{selected.adapter ? selected.adapter.label : selected.label}</h4>
                        {selected.adapter ? (
                          <span className="flex flex-wrap items-center gap-1.5">
                            <Tag mono>{selected.adapter.location}</Tag>
                            <Tag mono>{`${selected.adapter.vendorId}:${selected.adapter.productId}`}</Tag>
                            {selected.adapter.serial ? <Tag mono>{selected.adapter.serial}</Tag> : null}
                            {selected.adapter.hints.map((h) => <Tag key={h} tone="warn">{hintLabel(h)}</Tag>)}
                          </span>
                        ) : null}
                        <span className="ml-auto text-meta text-muted-foreground tabular-nums">{t.groupPorts(selected.ports.length, selected.ports.filter(isFreePort).length)}</span>
                      </header>
                      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2.5">
                        <Button data-wizard-assign-order onClick={() => assignInOrder(selected)} disabled={!draft.consoles.length}>
                          <ListOrderedIcon aria-hidden />
                          {t.assignInOrder}
                        </Button>
                        {/* The label says the state ("Vista previa en directo" / "Ocultar vista previa"): no aria-pressed on top. */}
                        <Button variant="outline" onClick={() => onState({ previewOn: !state.previewOn })} disabled={!previewPorts.length}>
                          {state.previewOn ? <EyeOffIcon aria-hidden /> : <EyeIcon aria-hidden />}
                          {state.previewOn ? t.hidePreview : t.preview}
                        </Button>
                        <Button variant="outline" data-wizard-identify onClick={() => void runIdentify(selected)} disabled={identify.pending || !freeKeysOf(selected).length} aria-busy={identify.pending || undefined}>
                          {identify.pending ? <LoaderCircleIcon aria-hidden className="animate-spin motion-reduce:hidden" /> : <ScanSearchIcon aria-hidden />}
                          {identify.pending ? t.identifying : t.identify}
                        </Button>
                        {hostOrder?.changed ? (
                          <Button
                            variant="outline"
                            onClick={() => {
                              onMapping(hostOrder.assignments.map((k, slotIndex) => ({ slotIndex, stableKey: k })))
                              onState({ notice: t.orderByHostnameDone })
                              // Once the order matches, this button goes away: focus stays in the toolbar.
                              focusNextFrame("[data-wizard-identify]", "[data-wizard-assign-order]")
                            }}
                          >
                            <ArrowDownUpIcon aria-hidden />
                            {t.orderByHostname}
                          </Button>
                        ) : null}
                        <p role="status" className="basis-full text-meta text-muted-foreground">
                          {state.notice ?? (hostOrder && !hostOrder.changed ? t.orderMatches : selected.adapter && skipInterfaces.length ? t.skippedInterfaces(interfaceList(skipInterfaces)) : "")}
                        </p>
                      </div>
                      {/* The preview sits right under the toolbar, next to "Asignar en orden" and the Consola selects. */}
                      {state.previewOn ? (
                        <div className="flex flex-col gap-2 border-b px-3 py-2.5">
                          <p className="text-meta text-muted-foreground">
                            {t.previewHint}{previewPorts.length > MAX_PREVIEWS ? ` ${t.previewLimited(MAX_PREVIEWS)}` : ""}
                          </p>
                          <div className="grid min-w-0 gap-3 lg:grid-cols-2">
                            {previewPorts.slice(0, MAX_PREVIEWS).map((p) => {
                              const slot = slotOfPort.get(p.stableKey)
                              return (
                                <div key={p.stableKey} className="flex min-w-0 flex-col gap-1">
                                  <div className="flex items-center gap-2">
                                    <span className="font-mono text-data font-semibold text-foreground">{portName(p)}</span>
                                    {slot ? <Tag tone="brand" mono>{slot.key}</Tag> : <span className="text-meta text-faint-foreground">{t.portUnused}</span>}
                                  </div>
                                  <LivePreview stableKey={p.stableKey} devNode={p.devNode} baudRate={slot?.line.baudRate ?? baud} />
                                </div>
                              )
                            })}
                          </div>
                        </div>
                      ) : null}
                      <ul className="divide-y">
                        {selected.ports.map((p) => (
                          <PortRow
                            key={p.stableKey}
                            port={p}
                            isNew={isNew(p.stableKey)}
                            slot={slotOfPort.get(p.stableKey) ?? null}
                            consoles={draft.consoles}
                            probe={state.probe[p.stableKey]}
                            onChoose={(uid) => {
                              if (uid) assignManually(uid, { stableKey: p.stableKey, matchBy: defaultMatchBy(p) })
                              else {
                                const current = slotOfPort.get(p.stableKey)
                                if (current) assignManually(current.uid, null)
                              }
                            }}
                          />
                        ))}
                      </ul>
                    </section>
                  </>
                ) : null}
              </div>
            )}
          </Section>
        </div>
      )}

      {draft.relays.length ? (
        <Section as="h3" title={t.relaysConnections} description={t.relaysCount(draft.relays.length)}>
          {!boards.length ? (
            <InlineAlert tone="warn">
              {t.noBoards}{" "}
              <AppLink href="/descubrimiento?tab=reles" className="text-brand underline underline-offset-4">{t.goDiscovery}</AppLink>
            </InlineAlert>
          ) : null}
          <ol className="flex flex-col gap-2">
            {draft.relays.map((r, i) => {
              const a = draft.relayTargets[r.uid]
              const skipped = a === "skip" || !boards.length
              const err = [...errorsFor(errors, `relays.${i}.boardId`), ...errorsFor(errors, `relays.${i}.channel`)]
              const id = `wizard-skip-${r.uid}`
              return (
                <li key={r.uid} className={cn("flex min-w-0 flex-col gap-2 rounded-lg border bg-card px-3 py-2.5 md:flex-row md:items-center", err.length && "border-danger/60")}>
                  <span className="flex min-w-0 items-baseline gap-2 md:w-56">
                    <span className="font-mono text-data font-semibold text-foreground">{r.key}</span>
                    <span className="min-w-0 truncate text-meta text-muted-foreground">{r.label}</span>
                  </span>
                  {boards.length ? (
                    <>
                      {skipped ? (
                        <span className="text-meta text-faint-foreground md:flex-1">{t.skipped}</span>
                      ) : (
                        <BoardChannelPicker
                          boards={boards}
                          value={isRelayTarget(a) ? a : null}
                          onChange={(v) => onRelayTarget(r.uid, v)}
                          taken={takenChannels(draft, r.uid)}
                          invalid={err.length > 0}
                          labelPrefix={`${r.key ?? r.label}: `}
                          className="md:flex-1"
                        />
                      )}
                      <span className="flex items-center gap-2">
                        <Checkbox id={id} checked={a === "skip"} onCheckedChange={(v) => onRelayTarget(r.uid, v === true ? "skip" : null)} aria-label={t.skipRelayFor(r.key ?? r.label)} />
                        <Label htmlFor={id} className="font-normal">{t.skipRelay}</Label>
                      </span>
                    </>
                  ) : (
                    <span className="text-meta text-faint-foreground">{t.relayWillSkip}</span>
                  )}
                  {err.length ? <p className="text-meta text-danger md:basis-full">{err.join(" ")}</p> : null}
                </li>
              )
            })}
          </ol>
        </Section>
      ) : null}

      <PortChoiceDialog
        open={!!dialogSlot}
        onOpenChange={(o) => { if (!o) setDialogFor(null) }}
        title={t.portDialogTitle(dialogSlot?.key ?? "")}
        snapshot={snapshot}
        hints={hints}
        initial={{ stableKey: dialogSlot ? draft.bindings[dialogSlot.uid]?.stableKey ?? null : null, matchBy: dialogSlot ? draft.bindings[dialogSlot.uid]?.matchBy ?? null : null }}
        selectable={(p) => isFreePort(p)}
        holderOf={(p) => draftPortHolder(p, portHolder(draft, p.stableKey), null)}
        showJtag={showJtag}
        onShowJtagChange={onShowJtagChange}
        baudRate={dialogSlot?.line.baudRate ?? baud}
        onConfirm={(c) => { if (dialogSlot) assignManually(dialogSlot.uid, { stableKey: c.stableKey, matchBy: c.matchBy }) }}
        returnFocus={lastDialogFor ? [dataSelector(PORT_TRIGGER, lastDialogFor)] : []}
      />
    </div>
  )
}

function PortRow({ port, isNew, slot, consoles, probe, onChoose }: {
  port: SerialPortDTO
  isNew: boolean
  slot: WizardDraft["consoles"][number] | null
  consoles: WizardDraft["consoles"]
  probe: ProbeResultDTO | undefined
  onChoose: (uid: string | null) => void
}) {
  const free = isFreePort(port)
  // The draft state reads the same as in the port dialog ("Asignado a este equipo · KEY"); `free` stays the real one.
  const shown = slot ? { ...port, assignment: { equipmentId: "", equipmentName: t.thisEquipment, consoleId: "", consoleKey: slot.key, consoleLabel: slot.key } } : port
  const st = portStatusView(shown)
  return (
    <li className={cn("grid min-w-0 grid-cols-[4.75rem_minmax(0,1fr)] items-center gap-x-3 gap-y-1.5 px-3 py-2 sm:grid-cols-[4.75rem_minmax(0,1fr)_9rem]", isNew && "animate-new-row")}>
      <span className={cn("font-mono text-data font-semibold", free ? "text-foreground" : "text-muted-foreground")}>{portName(port)}</span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <MiddleTruncate value={port.byId ?? port.devNode} tail={18} className="text-muted-foreground" />
        <span className="flex min-w-0 flex-wrap items-center gap-x-3">
          <StatusChip tone={st.tone} icon={st.icon} quiet>{st.label}</StatusChip>
          <ProbeChip result={probe} />
          {isNew ? <NewRowChip /> : null}
        </span>
      </span>
      {free && consoles.length ? (
        <Select value={slot?.uid ?? NONE} onValueChange={(v) => onChoose(v === NONE ? null : v)}>
          {/* Mono only for a console key: "Sin usar" is UI copy. */}
          <SelectTrigger size="sm" aria-label={`${t.portFor}: ${portName(port)}`} className={cn("w-full max-sm:col-start-2", slot && "border-brand font-mono text-data")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE} className="font-sans text-meta">{t.portUnused}</SelectItem>
            {consoles.map((c) => (
              <SelectItem key={c.uid} value={c.uid} className="font-mono text-data">{c.key}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : <span className="max-sm:hidden" />}
    </li>
  )
}
