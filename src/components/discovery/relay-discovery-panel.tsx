"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import {
  ArrowRightIcon, CircleCheckIcon, CircleDashedIcon, LoaderCircleIcon, NetworkIcon, PlusIcon, RadarIcon, RefreshCcwDotIcon, ToggleRightIcon,
  TriangleAlertIcon, WifiOffIcon, type LucideIcon,
} from "lucide-react"
import { AppLink } from "@/components/common/app-link"
import { ConfirmDialog } from "@/components/common/confirm-dialog"
import { DataTable, type DataColumn } from "@/components/common/data-table"
import { EmptyState } from "@/components/common/empty-state"
import { InlineAlert } from "@/components/common/inline-alert"
import { Section } from "@/components/common/page"
import { RelativeTime } from "@/components/common/relative-time"
import { StatusChip, type ChipTone } from "@/components/common/status-chip"
import { Button } from "@/components/ui/button"
import { Tag } from "@/components/ui/tag"
import { useAction } from "@/hooks/use-action"
import { useLiveState } from "@/hooks/use-live-state"
import { useServerEvents } from "@/hooks/use-server-events"
import { updateBoardHost } from "@/actions/boards"
import { runRelaySubnetScan, runRelayUdpDiscovery } from "@/actions/relay-discovery"
import type { ServerEvent, ServerEventType } from "@/lib/contracts/events"
import type { DiscoveredBoardDTO, RelayDiscoveryResultDTO } from "@/lib/contracts/relays"
import { discovery as t } from "@/lib/i18n/hardware"
import { discoverySourceLabel, RELAY_TEXT } from "@/lib/i18n/relays"
import {
  actionHints,
  discoveredAddress, discoveredMac, discoveredModel, discoveredRelayCount, discoveredState, sortDiscovered, upsertDiscovered,
  type DiscoveredState,
} from "./relay-model"
import { firstVisible, focusWhenLost } from "./focus"
import { ScanDialog } from "./scan-dialog"

const EVENTS: readonly ServerEventType[] = ["relay.discovered"]
const PROGRESS: readonly ServerEventType[] = ["discovery.progress"]

const STATE: Record<DiscoveredState, { tone: ChipTone; icon: LucideIcon }> = {
  new: { tone: "neutral", icon: CircleDashedIcon },
  registered: { tone: "neutral", icon: CircleCheckIcon },
  "ip-changed": { tone: "warn", icon: RefreshCcwDotIcon },
  unreachable: { tone: "danger", icon: WifiOffIcon },
}

function reduceKnown(list: DiscoveredBoardDTO[], e: ServerEvent): DiscoveredBoardDTO[] {
  return e.type === "relay.discovered" ? upsertDiscovered(list, e.board) : list
}

export interface RegisteredHost { id: string; name: string; host: string }

/**
 * Descubrimiento > Placas de relés (§8.9, D20–D22): every board seen since the server started (passive UDP,
 * "Buscar placas (UDP)" and scans, merged live through `relay.discovered`), with one-click "Añadir", "Ver" and the
 * audited "Actualizar IP" for a known MAC at a new address.
 */
function runSummary(r: RelayDiscoveryResultDTO): string {
  return r.kind === "udp" ? t.runSummaryUdp(r.boards.length, r.targets.join(", ")) : t.runSummaryScan(r.boards.length, r.targets.join(", "))
}

export function RelayDiscoveryPanel({ known, registered, scanDefaults }: {
  known: DiscoveredBoardDTO[]
  registered: RegisteredHost[]
  scanDefaults: { cidrs: string[]; ports: number[] }
}) {
  const router = useRouter()
  const serverList = React.useMemo(() => sortDiscovered(known), [known])
  const boards = useLiveState(serverList, EVENTS, reduceKnown)
  const [lastRun, setLastRun] = React.useState<RelayDiscoveryResultDTO | null>(null)
  const [scanOpen, setScanOpen] = React.useState(false)
  const scanButton = React.useRef<HTMLButtonElement>(null)
  const [progress, setProgress] = React.useState<{ done: number; total: number } | null>(null)
  const udpAct = useAction(runRelayUdpDiscovery)
  const scanAct = useAction(runRelaySubnetScan)
  const hostAct = useAction(updateBoardHost)
  const hosts = new Map(registered.map((r) => [r.id, r]))

  useServerEvents(PROGRESS, (e) => {
    if (e.type === "discovery.progress" && scanAct.pending) setProgress({ done: e.done, total: e.total })
  })

  const finish = (r: RelayDiscoveryResultDTO) => {
    setLastRun(r)
    router.refresh() // the server's merged map, including boards whose event was rate limited
  }
  const runUdp = async () => {
    const r = await udpAct.run({})
    if (r.ok) finish(r.data)
  }
  const runScan = async (input: { cidrs: string[]; ports: number[] }) => {
    setProgress(null)
    const r = await scanAct.run(input)
    setProgress(null)
    if (r.ok) {
      setScanOpen(false)
      finish(r.data)
    }
  }

  const columns: ReadonlyArray<DataColumn<DiscoveredBoardDTO>> = [
    {
      id: "model",
      header: t.colModel,
      cell: (b) => {
        const model = discoveredModel(b)
        return (
          <span className="flex min-w-0 flex-col">
            <span className={model ? "font-mono text-data font-semibold text-foreground" : "text-muted-foreground"}>{model ?? t.unknownModel}</span>
            {b.hostname && b.hostname !== model ? <span className="truncate text-meta text-muted-foreground">{b.hostname}</span> : null}
          </span>
        )
      },
      sortValue: (b) => discoveredModel(b),
      searchValue: (b) => `${discoveredModel(b) ?? ""} ${b.hostname ?? ""}`,
    },
    {
      id: "address",
      header: t.colAddress,
      cell: (b) => <span className="font-mono text-data whitespace-nowrap tabular-nums">{discoveredAddress(b)}</span>,
      sortValue: (b) => b.ip.split(".").map((o) => o.padStart(3, "0")).join("."),
      searchValue: (b) => b.ip,
    },
    { id: "mac", header: t.colMac, cell: (b) => <span className="font-mono text-data whitespace-nowrap text-muted-foreground">{discoveredMac(b) ?? ""}</span>, searchValue: (b) => discoveredMac(b) ?? "" },
    {
      id: "relays",
      header: t.colRelays,
      align: "right",
      cell: (b) => <span className="font-mono text-data">{discoveredRelayCount(b) ?? ""}</span>,
      sortValue: (b) => discoveredRelayCount(b),
    },
    { id: "firmware", header: t.colFirmware, cell: (b) => <span className="font-mono text-data text-muted-foreground">{b.detect?.firmware ?? ""}</span> },
    {
      id: "source",
      header: t.colSource,
      cell: (b) => (
        <span className="flex flex-wrap gap-1">
          {b.sources.map((s) => <Tag key={s} tone="outline">{discoverySourceLabel(s)}</Tag>)}
        </span>
      ),
    },
    {
      id: "state",
      header: t.colState,
      cell: (b) => <StateCell board={b} registeredHost={b.registeredBoardId ? hosts.get(b.registeredBoardId)?.host ?? null : null} updateIp={updateIpButton} />,
      sortValue: (b) => ["new", "ip-changed", "unreachable", "registered"].indexOf(discoveredState(b)),
      className: "min-w-56",
    },
  ]

  const busy = udpAct.pending || scanAct.pending
  const actions = (
    <>
      <Button variant="primary" pending={busy} onClick={() => void runUdp()}>
        {udpAct.pending ? <LoaderCircleIcon aria-hidden className="animate-spin motion-reduce:hidden" /> : <RadarIcon aria-hidden />}
        {udpAct.pending ? t.searchingUdp : t.searchUdp}
      </Button>
      <Button ref={scanButton} onClick={() => setScanOpen(true)} disabled={udpAct.pending} aria-busy={scanAct.pending || undefined}>
        {scanAct.pending ? <LoaderCircleIcon aria-hidden className="animate-spin motion-reduce:hidden" /> : <NetworkIcon aria-hidden />}
        {scanAct.pending ? t.scanning : t.scanSubnet}
      </Button>
    </>
  )

  /** "Actualizar IP" (D22): an audited, confirmed change; the dialog's own trigger gets focus back when it closes. */
  const updateIpButton = (b: DiscoveredBoardDTO) => {
    const reg = b.registeredBoardId ? hosts.get(b.registeredBoardId) ?? null : null
    const name = b.registeredBoardName ?? reg?.name ?? ""
    return (
      <ConfirmDialog
        trigger={<Button size="sm"><RefreshCcwDotIcon aria-hidden />{t.updateIp}</Button>}
        tone="primary"
        title={t.updateIpTitle(name)}
        description={t.updateIpBody(reg?.host ?? "?", b.ip, discoveredMac(b) ?? "")}
        confirmLabel={t.updateIpConfirm}
        onConfirm={async () => {
          if (!b.registeredBoardId) return true
          const r = await hostAct.run({ boardId: b.registeredBoardId, host: b.ip })
          if (!r.ok) return false
          toast.success(t.updateIpDone(name, b.ip))
          router.refresh()
          // The refreshed row swaps "Actualizar IP" for "Ver": keep keyboard focus on that row.
          focusWhenLost(() => firstVisible(`[data-row-action="${CSS.escape(b.key)}"]`))
          return true
        }}
      />
    )
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Section title={t.boardsTitle} description={t.boardsDescription} actions={actions}>
        {/* Always in the DOM so the first run is announced too; only the summary is spoken (the relative time ticks). */}
        <p className="sr-only" aria-live="polite">
          {lastRun ? `${runSummary(lastRun)}${lastRun.warnings.length ? `. ${t.runWarnings}` : ""}` : ""}
        </p>
        {lastRun ? (
          <div className="flex flex-col gap-2">
            <p className="flex items-start gap-1.5 text-meta text-muted-foreground">
              <CircleCheckIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-ok" />
              <span className="min-w-0">
                {runSummary(lastRun)}
                <span aria-hidden className="text-faint-foreground max-md:hidden">{" · "}</span>
                <RelativeTime value={lastRun.finishedAt} className="max-md:block" />
              </span>
            </p>
            {lastRun.warnings.length ? (
              <InlineAlert tone="warn" title={t.runWarnings}>
                <ul className="flex flex-col gap-0.5">{lastRun.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
              </InlineAlert>
            ) : null}
          </div>
        ) : null}

        {boards.length ? (
          <>
            <DataTable
              rows={boards}
              columns={columns}
              rowKey={(b) => b.key}
              search={boards.length > 8}
              caption={t.boardsTitle}
              className="max-md:hidden"
            />
            {/* Below 768 px the seven columns do not fit: one card per board, state and action first-class. */}
            <ul aria-label={t.boardsTitle} className="flex flex-col gap-2 md:hidden">
              {boards.map((b) => {
                const relays = discoveredRelayCount(b)
                const mac = discoveredMac(b)
                return (
                  <li key={b.key} className="flex min-w-0 flex-col gap-2 rounded-lg border bg-card p-3">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="font-mono text-data font-semibold text-foreground">{discoveredModel(b) ?? t.unknownModel}</span>
                      {relays ? <span className="text-meta text-muted-foreground tabular-nums">{t.relaysCount(relays)}</span> : null}
                    </div>
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-data text-muted-foreground tabular-nums">
                      <span className="text-foreground">{discoveredAddress(b)}</span>
                      {mac ? <span>{mac}</span> : null}
                      {b.detect?.firmware ? <span>{`${t.colFirmware} ${b.detect.firmware}`}</span> : null}
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {b.sources.map((src) => <Tag key={src} tone="outline">{discoverySourceLabel(src)}</Tag>)}
                    </div>
                    <StateCell board={b} registeredHost={b.registeredBoardId ? hosts.get(b.registeredBoardId)?.host ?? null : null} updateIp={updateIpButton} />
                  </li>
                )
              })}
            </ul>
          </>
        ) : (
          <EmptyState icon={ToggleRightIcon} title={t.emptyBoardsTitle}>{t.emptyBoardsBody}</EmptyState>
        )}
      </Section>

      <ScanDialog
        open={scanOpen}
        onOpenChange={setScanOpen}
        defaults={scanDefaults}
        running={scanAct.pending}
        progress={progress}
        onStart={(input) => void runScan(input)}
        returnFocusRef={scanButton}
      />

    </div>
  )
}

function StateCell({ board: b, registeredHost, updateIp }: { board: DiscoveredBoardDTO; registeredHost: string | null; updateIp: (b: DiscoveredBoardDTO) => React.ReactNode }) {
  const state = discoveredState(b)
  const shownHints = actionHints(b.hints)
  const s = STATE[state]
  const label = state === "new" ? t.stateNew : state === "registered" ? t.stateRegistered(b.registeredBoardName ?? "") : state === "ip-changed" ? t.stateIpChanged : t.stateUnreachable
  const model = discoveredModel(b) ?? b.ip
  return (
    <div className="flex min-w-0 flex-col items-start gap-1.5 py-0.5">
      <div className="flex flex-wrap items-center gap-2">
        <StatusChip tone={s.tone} icon={s.icon}>{label}</StatusChip>
        {state === "new" ? (
          <Button asChild size="sm">
            <AppLink href={`/placas/nueva?desde=${encodeURIComponent(b.key)}`} aria-label={t.addLabel(`${model} ${b.ip}`)}><PlusIcon aria-hidden />{t.add}</AppLink>
          </Button>
        ) : null}
        {state === "registered" && b.registeredBoardId ? (
          <Button asChild size="sm">
            <AppLink href={`/placas/${b.registeredBoardId}`} data-row-action={b.key} aria-label={t.viewLabel(b.registeredBoardName ?? model)}>{t.view}<ArrowRightIcon aria-hidden /></AppLink>
          </Button>
        ) : null}
        {state === "ip-changed" ? (
          updateIp(b)
        ) : null}
      </div>
      {state === "ip-changed" && registeredHost ? (
        <p className="text-meta text-muted-foreground">{t.registeredAt(registeredHost)}</p>
      ) : null}
      {state === "unreachable" ? (
        <p className="flex max-w-80 items-start gap-1.5 text-meta whitespace-normal text-muted-foreground">
          <TriangleAlertIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-warn" />
          {RELAY_TEXT.hintUnreachable}
        </p>
      ) : null}
      {shownHints.length && state !== "unreachable" ? (
        <p className="max-w-80 text-meta whitespace-normal text-faint-foreground">{shownHints.join(" · ")}</p>
      ) : null}
    </div>
  )
}
