"use client"

import * as React from "react"
import { toast } from "sonner"
import {
  CableIcon, ChevronRightIcon, CornerDownLeftIcon, EllipsisIcon, EyeIcon, EyeOffIcon, LinkIcon, LoaderCircleIcon, RefreshCwIcon, ScanSearchIcon, TriangleAlertIcon, UsbIcon, XIcon,
} from "lucide-react"
import { AppLink } from "@/components/common/app-link"
import { ConfirmDialog } from "@/components/common/confirm-dialog"
import { EmptyState } from "@/components/common/empty-state"
import { RelativeTime } from "@/components/common/relative-time"
import { AdapterGroup } from "@/components/serial/adapter-group"
import { LivePreview } from "@/components/serial/live-preview"
import { SerialHints } from "@/components/serial/serial-hints"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { SimpleTooltip } from "@/components/ui/tooltip"
import { useAction } from "@/hooks/use-action"
import { useLiveState } from "@/hooks/use-live-state"
import { useServerEvents } from "@/hooks/use-server-events"
import { identifyPorts, pokePort, rescanSerial } from "@/actions/consoles"
import type { ServerEvent, ServerEventType } from "@/lib/contracts/events"
import type { HealthCheckDTO } from "@/lib/contracts/system"
import { portGroups, type PortGroup, type ProbeResultDTO, type SerialPageDTO, type SerialPortDTO, type SerialSnapshotDTO } from "@/lib/contracts/serial"
import { discovery as t } from "@/lib/i18n/hardware"
import { cn } from "@/lib/client/cn"
import { AssignDialog, type AssignEquipment } from "./assign-dialog"
import { firstVisible, focusReturnTarget, focusWhenLost } from "./focus"
import { ProbeResults } from "./probe-results"
import {
  canIdentify, canPoke, canPreview, emptyStateHints, identifyTargets, isFreePort, newPortKeys, portCounts, portDisplayName, singlePortGroup,
} from "./serial-model"

const EVENTS: readonly ServerEventType[] = ["serial.changed"]
const NEW_MS = 10_000

function reduceSnapshot(s: SerialSnapshotDTO, e: ServerEvent): SerialSnapshotDTO {
  return e.type === "serial.changed" ? e.snapshot : s
}

/**
 * Descubrimiento > Puertos serie (§8.9): live adapter groups (hot-plug through `serial.changed`, new rows
 * highlighted), rescan, JTAG toggle, and per-port preview, identify, carriage return and "Asignar a equipo…".
 * It stays mounted while the other tab is shown (`active` false), so no event is missed; hiding it closes the
 * preview, which would otherwise keep the port open out of sight.
 */
export function SerialPortsPanel({ data, equipment, active = true }: { data: SerialPageDTO; equipment: AssignEquipment[]; active?: boolean }) {
  const snapshot = useLiveState(data.snapshot, EVENTS, reduceSnapshot)
  const [showJtag, setShowJtag] = React.useState(!data.hideJtag)
  const [fresh, setFresh] = React.useState<ReadonlySet<string>>(() => new Set())
  const [announce, setAnnounce] = React.useState("")
  const [preview, setPreview] = React.useState<string | null>(null)
  const [results, setResults] = React.useState<Record<string, ProbeResultDTO>>({})
  const [probing, setProbing] = React.useState<ReadonlySet<string>>(() => new Set())
  const [assign, setAssign] = React.useState<{ group: PortGroup; single: SerialPortDTO | null } | null>(null)
  const [assignOpen, setAssignOpen] = React.useState(false)
  const [poke, setPoke] = React.useState<SerialPortDTO | null>(null)
  const [pokeOpen, setPokeOpen] = React.useState(false)
  const [wasActive, setWasActive] = React.useState(active)
  if (wasActive !== active) {
    setWasActive(active)
    if (!active) setPreview(null)
  }
  // Neither dialog has a Radix trigger (they open from a group button or a row menu item): remember the opener.
  const assignReturn = React.useRef<HTMLElement | null>(null)
  const pokeReturn = React.useRef<HTMLElement | null>(null)
  const openAssign = (target: { group: PortGroup; single: SerialPortDTO | null }) => {
    assignReturn.current = focusReturnTarget()
    setAssign(target)
    setAssignOpen(true)
  }
  const openPoke = (p: SerialPortDTO) => {
    pokeReturn.current = focusReturnTarget()
    setPoke(p)
    setPokeOpen(true)
  }
  const rescanAct = useAction(rescanSerial, { successMessage: t.rescanDone })
  // The empty state's button disappears when the rescan finds ports: focus moves to the toolbar's.
  const rescanFromEmpty = async () => {
    await rescanAct.run({})
    focusWhenLost(() => firstVisible("[data-serial-rescan]"), 2000)
  }
  const identifyAct = useAction(identifyPorts)
  const pokeAct = useAction(pokePort)

  // Hot-plug highlight: ports that appear after the first render get `animate-new-row` (and the reduced-motion
  // "Nuevo" chip) for 10 s.
  const prev = React.useRef(snapshot)
  React.useEffect(() => {
    const added = newPortKeys(prev.current, snapshot)
    prev.current = snapshot
    if (!added.length) return
    setFresh((s) => new Set([...s, ...added]))
    const timer = window.setTimeout(() => setFresh((s) => new Set([...s].filter((k) => !added.includes(k)))), NEW_MS)
    return () => window.clearTimeout(timer)
  }, [snapshot])
  useServerEvents(EVENTS, (e) => {
    if (e.type === "serial.changed" && e.change.kind !== "rescan") setAnnounce(e.change.label)
  })

  const jtagAdapters = snapshot.adapters.filter((a) => a.hints.includes("jtag-probable")).length
  const groups = portGroups(snapshot, { showJtag })
  const counts = portCounts(groups)
  const previewPort = preview ? groups.flatMap((g) => g.ports).find((p) => p.stableKey === preview) ?? null : null

  const identify = async (keys: string[]) => {
    if (!keys.length) return
    setProbing((s) => new Set([...s, ...keys]))
    // The preview holds the port: close it first so the probe can open it.
    if (preview && keys.includes(preview)) setPreview(null)
    const r = await identifyAct.run({ stableKeys: keys, baudRate: 115200, listenMs: 3000 })
    setProbing((s) => new Set([...s].filter((k) => !keys.includes(k))))
    if (r.ok) setResults((cur) => ({ ...cur, ...Object.fromEntries(r.data.map((p) => [p.stableKey, p])) }))
  }

  const clearResults = (g: PortGroup) => setResults((cur) => {
    const next = { ...cur }
    for (const p of g.ports) delete next[p.stableKey]
    return next
  })

  const renderActions = (g: PortGroup, p: SerialPortDTO) => {
    const name = portDisplayName(p)
    const busy = probing.has(p.stableKey)
    const previewing = preview === p.stableKey
    const previewReason = p.assignment ? t.previewBound : t.previewBlocked
    return (
      <>
        <SimpleTooltip label={canPreview(p) ? (previewing ? t.previewClose : t.preview) : previewReason}>
          <span>
            <Button
              size="icon-sm"
              variant={previewing ? "default" : "ghost"}
              aria-label={previewing ? t.previewClose : t.previewOf(name)}
              aria-pressed={previewing}
              disabled={!canPreview(p)}
              onClick={() => setPreview(previewing ? null : p.stableKey)}
            >
              {previewing ? <EyeOffIcon aria-hidden /> : <EyeIcon aria-hidden />}
            </Button>
          </span>
        </SimpleTooltip>
        <SimpleTooltip label={busy ? t.identifying : t.identify}>
          <span>
            <Button size="icon-sm" variant="ghost" aria-label={t.identifyOf(name)} disabled={!canIdentify(p)} pending={busy} onClick={() => void identify([p.stableKey])}>
              {busy ? <LoaderCircleIcon aria-hidden className="animate-spin motion-reduce:animate-none" /> : <ScanSearchIcon aria-hidden />}
            </Button>
          </span>
        </SimpleTooltip>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon-sm" variant="ghost" aria-label={t.moreActions(name)}><EllipsisIcon aria-hidden /></Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {p.assignment ? (
              <DropdownMenuItem asChild>
                <AppLink href={`/equipos/${p.assignment.equipmentId}`}><LinkIcon aria-hidden />{t.openEquipment(p.assignment.equipmentName)}</AppLink>
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem disabled={!isFreePort(p)} onSelect={() => openAssign({ group: singlePortGroup(g, p), single: p })}>
                <CableIcon aria-hidden />{t.assignPort}
              </DropdownMenuItem>
            )}
            {data.allowPoke ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem disabled={!canPoke(p, data.allowPoke) || previewing} onSelect={() => openPoke(p)}>
                  <CornerDownLeftIcon aria-hidden />
                  <span className="flex flex-col">
                    {t.pokeMenu}
                    {!canPoke(p, data.allowPoke) ? <span className="text-meta text-muted-foreground">{t.pokeOnlyFree}</span> : previewing ? <span className="text-meta text-muted-foreground">{t.pokeClosePreview}</span> : null}
                  </span>
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </>
    )
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        {/* With no ports the empty state carries the only "Volver a escanear". */}
        {groups.length ? (
          <Button data-serial-rescan pending={rescanAct.pending} onClick={() => void rescanAct.run({})}>
            <RefreshCwIcon aria-hidden className={cn(rescanAct.pending && "animate-spin motion-reduce:animate-none")} />
            {rescanAct.pending ? t.rescanning : t.rescan}
          </Button>
        ) : null}
        {jtagAdapters > 0 ? (
          <div className="flex items-center gap-2">
            <Switch id="show-jtag" checked={showJtag} onCheckedChange={setShowJtag} />
            <Label htmlFor="show-jtag" className="font-normal">{t.showJtag(jtagAdapters)}</Label>
          </div>
        ) : null}
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-meta text-muted-foreground md:ml-auto">
          {counts.total ? (
            <>
              <span className="tabular-nums">{t.portsSummary(counts.total, counts.free, counts.assigned)}</span>
              <span aria-hidden className="text-faint-foreground max-md:hidden">·</span>
            </>
          ) : null}
          <span>{t.lastScan} <RelativeTime value={snapshot.scannedAt} className="text-foreground" /></span>
          <span aria-hidden className="text-faint-foreground max-md:hidden">·</span>
          <span title={snapshot.watcher.inotify ? t.watcherInotifyHint : t.watcherPollHint}>
            {snapshot.watcher.inotify ? t.watcherInotify : t.watcherPoll(Math.round(snapshot.watcher.intervalMs / 1000))}
          </span>
        </p>
      </div>

      <p className="sr-only" role="status" aria-live="polite" aria-label={t.liveRegionLabel}>{announce}</p>

      {groups.length ? <HintsDisclosure checks={data.serialHints} /> : null}

      {groups.length === 0 ? (
        <>
          <EmptyState
            icon={UsbIcon}
            title={t.emptyTitle}
            actions={(
              <Button pending={rescanAct.pending} onClick={() => void rescanFromEmpty()}>
                <RefreshCwIcon aria-hidden />{t.rescan}
              </Button>
            )}
          >
            <p>{t.emptyBody}</p>
            <p className="mt-1 text-meta">{t.emptyRescanHint}</p>
          </EmptyState>
          <SerialHints checks={emptyStateHints(data.serialHints)} />
        </>
      ) : (
        <section aria-labelledby="serial-ports-heading" className="flex min-w-0 flex-col gap-4">
          {/* The group headers are h3: this keeps the outline h1 > h2 > h3 without a visible title over the list. */}
          <h2 id="serial-ports-heading" className="sr-only">{t.portsHeading}</h2>
          {groups.map((g) => {
            const name = g.adapter ? g.adapter.label : g.label
            const free = g.ports.filter(isFreePort).length
            const targets = identifyTargets(g)
            const groupBusy = targets.length > 0 && targets.every((k) => probing.has(k))
            const groupPreview = previewPort && g.ports.includes(previewPort) ? previewPort : null
            return (
              <div key={g.key} className="flex min-w-0 flex-col gap-2">
                <AdapterGroup
                  group={g}
                  isNew={(k) => fresh.has(k)}
                  renderPortActions={(p) => renderActions(g, p)}
                  headerAside={(
                    <>
                      <Button size="sm" variant="ghost" disabled={!targets.length} aria-label={t.identifyAllLabel(name)} pending={groupBusy} onClick={() => void identify(targets)}>
                        {groupBusy ? <LoaderCircleIcon aria-hidden className="animate-spin motion-reduce:animate-none" /> : <ScanSearchIcon aria-hidden />}
                        {t.identifyAll}
                      </Button>
                      <Button size="sm" onClick={() => openAssign({ group: g, single: null })} disabled={free === 0} aria-label={t.assignGroupLabel(name)}>
                        <CableIcon aria-hidden />{t.assignGroup}
                      </Button>
                    </>
                  )}
                />
                {groupPreview ? (
                  <div className="flex flex-col gap-1.5 rounded-lg border bg-card p-2">
                    <div className="flex items-center justify-between gap-2 px-1">
                      <span className="text-micro text-muted-foreground">{t.previewOf(portDisplayName(groupPreview))}</span>
                      <Button size="icon-sm" variant="ghost" aria-label={t.previewClose} onClick={() => setPreview(null)}><XIcon aria-hidden /></Button>
                    </div>
                    <LivePreview key={groupPreview.stableKey} stableKey={groupPreview.stableKey} devNode={groupPreview.devNode} />
                  </div>
                ) : null}
                <ProbeResults ports={g.ports} results={results} onClear={() => clearResults(g)} title={t.resultsFor(name)} />
              </div>
            )
          })}
        </section>
      )}

      {assign ? (
        <AssignDialog
          key={assign.group.key}
          open={assignOpen}
          onOpenChange={setAssignOpen}
          group={assign.group}
          returnFocus={() => assignReturn.current}
          single={assign.single}
          equipment={equipment}
        />
      ) : null}

      <ConfirmDialog
        open={pokeOpen}
        onOpenChange={setPokeOpen}
        returnFocus={() => pokeReturn.current}
        title={poke ? t.pokeTitle(portDisplayName(poke)) : ""}
        description={t.pokeBody}
        checkbox={{ label: t.pokeUnderstand }}
        requireCheckbox
        tone="primary"
        confirmLabel={t.pokeConfirm}
        onConfirm={async () => {
          if (!poke) return true
          const r = await pokeAct.run({ stableKey: poke.stableKey, baudRate: 115200, confirmed: true })
          if (!r.ok) return false
          setResults((cur) => ({ ...cur, [r.data.stableKey]: r.data }))
          toast.success(t.pokeDone(portDisplayName(poke)))
          return true
        }}
      />
    </div>
  )
}

/**
 * Configuration hints (dialout, ModemManager, brltty…) while ports are listed: one quiet line that expands, so the
 * port list stays the first thing on the page. With no ports the hints are shown in full under the empty state.
 */
function HintsDisclosure({ checks }: { checks: HealthCheckDTO[] }) {
  const [open, setOpen] = React.useState(false)
  const shown = checks.filter((c) => c.level !== "ok")
  if (!shown.length) return null
  const serious = shown.some((c) => c.level === "fail" || c.level === "warn")
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="flex flex-col gap-2">
      <CollapsibleTrigger asChild>
        <button type="button" className="-mx-1 flex w-fit items-center gap-1.5 rounded-sm px-1 text-body text-foreground hover:text-brand">
          <ChevronRightIcon aria-hidden className={cn("size-4 text-muted-foreground transition-transform duration-150 ease-(--ease-out) motion-reduce:transition-none", open && "rotate-90")} />
          <TriangleAlertIcon aria-hidden className={cn("size-4", serious ? "text-warn" : "text-muted-foreground")} />
          {t.hintsToggle(shown.length)}
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <SerialHints checks={checks} />
      </CollapsibleContent>
    </Collapsible>
  )
}
