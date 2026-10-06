"use client"

import * as React from "react"
import { InfoIcon, SettingsIcon, SquareTerminalIcon } from "lucide-react"
import { AppLink } from "@/components/common/app-link"
import { EmptyState } from "@/components/common/empty-state"
import { InlineAlert } from "@/components/common/inline-alert"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { RelayRail } from "@/components/relays/relay-rail"
import { reduceRelayLive, type RelayLive } from "@/components/relays/relay-model"
import { ClockTime } from "@/components/reservation/reservation-chip"
import type { TerminalHandle, TerminalStatus } from "@/components/terminal/terminal"
import type { EquipmentWorkspaceDTO } from "@/lib/contracts/equipment"
import { layoutKey } from "@/lib/client/prefs"
import { useLiveState } from "@/hooks/use-live-state"
import { useMediaQuery } from "@/hooks/use-media-query"
import { useMounted } from "@/hooks/use-mounted"
import { usePreference } from "@/hooks/use-preference"
import { reservation as rt, shortName, workspace as t } from "@/lib/i18n/banco"
import { ConsolePane } from "./console-pane"
import { ConsolePanes } from "./console-panes"
import { useEquipment } from "./equipment-context"
import { effectiveLayout, gridColumns, parseShortcut } from "./layout-model"
import { CONSOLE_EVENTS, reduceConsoleList, viewersSummary } from "./runtime-merge"
import { WorkspaceStatusBar } from "./workspace-status-bar"
import { AccessesStatusLink } from "@/components/accesses/accesses-panel"

const RELAY_EVENTS = ["relay.state"] as const

/** "Solo lectura…" banner for anyone who is not the holder (§8.9). */
function ReadOnlyBanner() {
  const { equipment, reservation, isHolder, actions } = useEquipment()
  if (isHolder) return null
  if (!reservation) {
    return (
      <InlineAlert
        tone="info"
        icon={InfoIcon}
        className="py-1.5"
        actions={<Button size="sm" variant="outline" onClick={() => void actions.reserve(null)} disabled={actions.pending.reserve}>{rt.reserve}</Button>}
      >
        {equipment.consoleCount ? rt.readOnlyFree : rt.readOnlyFreeRelays}
      </InlineAlert>
    )
  }
  return (
    <InlineAlert tone="warn" icon={InfoIcon} className="py-1.5">
      {rt.readOnlyOtherLead(shortName(reservation.holderName))}
      <ClockTime value={reservation.expiresAt} />.
      {reservation.note ? <span className="text-muted-foreground"> {rt.noteOf(reservation.note)}</span> : null}
    </InlineAlert>
  )
}

/** Skeleton panes for the server render and hydration (the layout depends on browser preferences). */
function PanesSkeleton({ n }: { n: number }) {
  const cols = Math.min(Math.max(n, 1), n >= 4 ? 2 : 3)
  return (
    <div className="grid h-full min-h-0 gap-2" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }} aria-hidden>
      {Array.from({ length: Math.min(n, 6) }, (_, i) => (
        <div key={i} className="flex min-h-0 flex-col overflow-hidden rounded-md border bg-card">
          <div className="flex h-7 items-center gap-2 border-b px-2"><Skeleton className="h-3 w-24" /><Skeleton className="h-3 w-16" /></div>
          <div className="min-h-0 flex-1 bg-terminal-bg" />
        </div>
      ))}
    </div>
  )
}

/**
 * The Consolas tab (§8.9): read-only banner, console panes in the chosen layout, the relay rail (only with relays)
 * and the status bar. Consoles first: relays never take space from a unit that has none.
 */
export function Workspace({ data }: { data: EquipmentWorkspaceDTO }) {
  const { equipment, isHolder, viewer } = useEquipment()
  const consoles = useLiveState(data.consoles, CONSOLE_EVENTS, (s, e) => reduceConsoleList(s, e, data.id))
  const relayBase = React.useMemo<RelayLive>(() => ({ relays: data.relays, at: null }), [data.relays])
  const relayLive = useLiveState(relayBase, RELAY_EVENTS, (s, e) => reduceRelayLive(s, e, data.id))
  const mounted = useMounted()
  const narrow = useMediaQuery("(max-width: 767px)")
  const wide = useMediaQuery("(min-width: 1600px)")
  const [pref, setPref] = usePreference(layoutKey(data.id))
  const n = consoles.length
  const layout = effectiveLayout(pref, n, narrow)
  const [maximized, setMaximized] = React.useState<string | null>(null)
  const [activeTab, setActiveTab] = React.useState<string>(() => consoles[0]?.id ?? "relays")
  const [railCollapsed, setRailCollapsed] = React.useState(false)
  const [statuses, setStatuses] = React.useState<Record<string, TerminalStatus>>({})
  const handles = React.useRef(new Map<string, TerminalHandle>())
  const canAct = isHolder

  const registerHandle = React.useCallback((id: string, h: TerminalHandle | null) => {
    if (h) handles.current.set(id, h)
    else handles.current.delete(id)
  }, [])
  const onStatus = React.useCallback((id: string, s: TerminalStatus) => {
    setStatuses((prev) => (prev[id] === s ? prev : { ...prev, [id]: s }))
  }, [])
  const toggleMaximize = React.useCallback((id: string) => {
    setMaximized((m) => (m === id ? null : id))
  }, [])

  // A console that disappears (reconfigured) cannot stay maximised or selected.
  const ids = consoles.map((c) => c.id).join(",")
  const [lastIds, setLastIds] = React.useState(ids)
  if (lastIds !== ids) {
    setLastIds(ids)
    if (maximized && !consoles.some((c) => c.id === maximized)) setMaximized(null)
    if (activeTab !== "relays" && !consoles.some((c) => c.id === activeTab)) setActiveTab(consoles[0]?.id ?? "relays")
  }

  // Unload guard (§8.9): the holder with at least one console open in rw (Ctrl+W typed in a shell closes the tab).
  const writing = isHolder && Object.values(statuses).some((s) => s.mode === "rw" && s.state.kind === "open")
  React.useEffect(() => {
    if (!writing) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = t.unloadGuard
      return t.unloadGuard
    }
    window.addEventListener("beforeunload", onBeforeUnload)
    return () => window.removeEventListener("beforeunload", onBeforeUnload)
  }, [writing])

  const relaysId = `${data.id}-relays`
  const statusBarId = `${data.id}-status`
  /** Shows and focuses console `index` (tabs layout: selects its tab; a maximised other pane is restored). */
  const focusConsole = (index: number) => {
    const c = consoles[index]
    if (!c) return
    if (layout === "tabs") setActiveTab(c.id)
    if (maximized && maximized !== c.id) setMaximized(null)
    requestAnimationFrame(() => handles.current.get(c.id)?.focus())
  }
  /** Moves focus into a region: its first control, else the region itself (tabIndex -1). */
  const focusRegion = (id: string) => {
    if (id === relaysId && layout === "tabs") setActiveTab("relays")
    requestAnimationFrame(() => {
      const el = document.getElementById(id)
      const first = el?.querySelector<HTMLElement>("button:not(:disabled), [href], input:not(:disabled), [role=combobox], [tabindex='0']")
      ;(first ?? el)?.focus()
    })
  }

  // Keyboard shortcuts (§8.9): Ctrl+Alt+1..9, Ctrl+Alt+Enter, Esc. The terminal returns false for these chords.
  const onKey = React.useEffectEvent((e: KeyboardEvent) => {
    const target = e.target instanceof Element ? e.target : null
    // Only xterm's input textarea sends keys to the port; its scrollable viewport (focusable in Chrome) does not.
    const inTerminal = !!target?.matches(".xterm-helper-textarea")
    const sc = parseShortcut(e, { maximized: maximized !== null, inTerminal })
    if (!sc) return
    if (sc.kind === "focus") {
      if (!consoles[sc.index]) return
      e.preventDefault()
      focusConsole(sc.index)
    } else if (sc.kind === "toggle-maximize") {
      if (layout === "tabs" || !n) return
      e.preventDefault()
      const focused = target?.closest("[data-console-pane]")?.getAttribute("data-console-id") ?? null
      const id = maximized ?? focused ?? consoles[0].id
      setMaximized((m) => (m ? null : id))
      requestAnimationFrame(() => handles.current.get(id)?.focus())
    } else {
      e.preventDefault()
      setMaximized(null)
    }
  })
  React.useEffect(() => {
    const h = (e: KeyboardEvent) => onKey(e)
    document.addEventListener("keydown", h)
    return () => document.removeEventListener("keydown", h)
  }, [])

  const viewers = viewersSummary(consoles.map((c) => ({ key: c.key, viewers: statuses[c.id]?.viewers ?? [] })))
  const relays = relayLive.relays
  const hasRelays = relays.length > 0

  // ── 0 consoles ──────────────────────────────────────────────────────────────────────────────────────────────
  if (!n) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4 md:p-6">
          {hasRelays ? (
            <div className="flex w-full max-w-3xl flex-col gap-3">
              <ReadOnlyBanner />
              <RelayRail relays={relays} equipmentId={data.id} equipmentName={equipment.name} canAct={canAct} lastAt={relayLive.at} variant="full" />
            </div>
          ) : (
            <EmptyState
              icon={SquareTerminalIcon}
              className="max-w-3xl"
              title={t.noConsolesNoRelaysTitle}
              actions={viewer.isAdmin ? (
                <Button asChild variant="primary">
                  <AppLink href={`/equipos/${data.id}/ajustes`}><SettingsIcon aria-hidden />{t.configure}</AppLink>
                </Button>
              ) : null}
            >
              {viewer.isAdmin ? t.noConsolesNoRelaysBody : t.noConsolesNoRelaysUser}
            </EmptyState>
          )}
        </div>
      </div>
    )
  }

  const gridCols = gridColumns(n, wide ? 1600 : 1440)
  const renderPane = (c: (typeof consoles)[number]) => (
    <ConsolePane
      console={c}
      maximized={maximized === c.id}
      hiddenByMaximize={maximized !== null && maximized !== c.id}
      onToggleMaximize={toggleMaximize}
      onStatus={onStatus}
      registerHandle={registerHandle}
    />
  )
  const relayRail = hasRelays ? (
    <RelayRail id={relaysId} className={narrow ? undefined : "order-last"} relays={relays} equipmentId={data.id} equipmentName={equipment.name} canAct={canAct} lastAt={relayLive.at} variant={narrow ? "tab" : "rail"} collapsed={railCollapsed} onCollapsedChange={setRailCollapsed} />
  ) : null

  // DOM order ≠ visual order on purpose: the terminal keeps Tab, so everything that must stay reachable with a
  // forward Tab (skip links, relay rail, status bar) comes before the consoles and is placed visually with `order`.
  return (
    <div className="relative flex h-full min-h-0 flex-col" data-layout={layout}>
      {!isHolder ? <div className="shrink-0 px-2 pt-2 md:px-3"><ReadOnlyBanner /></div> : null}
      <nav
        aria-label={t.skipNav}
        className="sr-only focus-within:not-sr-only focus-within:absolute focus-within:top-2 focus-within:left-2 focus-within:z-30 focus-within:flex focus-within:max-w-[calc(100%-1rem)] focus-within:flex-wrap focus-within:gap-1 focus-within:rounded-md focus-within:border focus-within:bg-popover focus-within:p-1 focus-within:shadow-md"
      >
        {consoles.map((c, i) => (
          <Button key={c.id} size="sm" variant="ghost" onClick={() => focusConsole(i)}>{t.skipTo} <span className="font-mono">{c.key}</span></Button>
        ))}
        {hasRelays ? <Button size="sm" variant="ghost" onClick={() => focusRegion(relaysId)}>{t.skipToRelays}</Button> : null}
        <Button size="sm" variant="ghost" onClick={() => focusRegion(statusBarId)}>{t.skipToStatusBar}</Button>
      </nav>
      <WorkspaceStatusBar
        id={statusBarId}
        className="order-last"
        layout={layout}
        onLayoutChange={(l) => {
          setMaximized(null)
          setPref(l)
        }}
        layoutForced={narrow}
        viewers={viewers}
        showLayout={n > 1}
        aside={<AccessesStatusLink equipmentId={data.id} accesses={data.accesses} />}
      />
      <div className="flex min-h-0 flex-1">
        {!narrow && relayRail ? relayRail : null}
        <div role="region" aria-label={t.consolesRegion} className="relative flex min-h-0 min-w-0 flex-1 flex-col p-2 md:p-3">
          {mounted ? (
            <ConsolePanes
              equipmentId={data.id}
              consoles={consoles}
              layout={layout}
              gridCols={gridCols}
              renderPane={renderPane}
              relaysTab={narrow ? relayRail : null}
              activeTab={activeTab}
              onActiveTabChange={setActiveTab}
            />
          ) : (
            <PanesSkeleton n={n} />
          )}
        </div>
      </div>
    </div>
  )
}
