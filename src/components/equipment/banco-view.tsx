"use client"

import type { EquipnetStatusDTO } from "@/lib/contracts/equipnet"
import { EquipnetOfferCard } from "@/components/equipnet/equipnet-offer-card"
import * as React from "react"
import { useRouter } from "next/navigation"
import { PlugIcon, PlusIcon, SearchIcon, ServerIcon, XIcon } from "lucide-react"
import { AppLink } from "@/components/common/app-link"
import { EmptyState } from "@/components/common/empty-state"
import { InlineAlert } from "@/components/common/inline-alert"
import { Page, PageHeader } from "@/components/common/page"
import { SegmentedControl } from "@/components/common/segmented-control"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Kbd } from "@/components/ui/kbd"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useServerEvents, useStale } from "@/components/providers/events-provider"
import { countUnassigned } from "@/components/shell/chips"
import { useShell } from "@/components/shell/shell-context"
import type { EquipmentCardDTO } from "@/lib/contracts/equipment"
import { useLiveState } from "@/hooks/use-live-state"
import { banco as t } from "@/lib/i18n/banco"
import { cn } from "@/lib/client/cn"
import {
  BANCO_EVENTS, bancoCounts, defaultFilters, filterCards, hasActiveFilters, reduceCards, summaryText, templateOptions,
  type BancoFilters, type OnlyFilter,
} from "./banco-model"
import { EquipmentUnit } from "./equipment-unit"

const REFRESH_DEBOUNCE_MS = 300
const SERIAL_EVENTS = ["serial.changed"] as const
const SETUP_ALERT_KEY = "rm-banco-setup-alert"

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false
  return el.isContentEditable || el.closest("input, textarea, select, [role=combobox], [role=textbox], .xterm") !== null
}

type OverflowEdges = { start: boolean; end: boolean }

/**
 * Which edges of a horizontal scroller hide content, so a fade can say "there is more" where the scrollbar is
 * hidden. Recomputed on scroll and on resize of the scroller or its content.
 */
function useOverflowEdges(): [(el: HTMLElement | null) => void, OverflowEdges] {
  const [el, setEl] = React.useState<HTMLElement | null>(null)
  const [edges, setEdges] = React.useState<OverflowEdges>({ start: false, end: false })
  React.useEffect(() => {
    if (!el) return
    const update = () => {
      const start = el.scrollLeft > 1
      const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 1
      setEdges((p) => (p.start === start && p.end === end ? p : { start, end }))
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    if (el.firstElementChild) ro.observe(el.firstElementChild)
    el.addEventListener("scroll", update, { passive: true })
    return () => {
      ro.disconnect()
      el.removeEventListener("scroll", update)
    }
  }, [el])
  return [setEl, edges]
}

const FADE_MASK = {
  end: "[mask-image:linear-gradient(to_right,#000_calc(100%-2.5rem),transparent)]",
  start: "[mask-image:linear-gradient(to_left,#000_calc(100%-2.5rem),transparent)]",
  both: "[mask-image:linear-gradient(to_right,transparent,#000_2.5rem,#000_calc(100%-2.5rem),transparent)]",
}

/** Filter bar (§8.9): template chips from the data, search ("/" focuses it), "Solo míos" / "Solo libres". */
function BancoFilterBar({ cards, filters, onChange, shown }: {
  cards: EquipmentCardDTO[]
  filters: BancoFilters
  onChange: (f: BancoFilters) => void
  shown: number
}) {
  const search = React.useRef<HTMLInputElement>(null)
  const templates = templateOptions(cards)
  const [chipScroller, chipEdges] = useOverflowEdges()
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.ctrlKey || e.altKey || e.metaKey || isTypingTarget(e.target)) return
      e.preventDefault()
      search.current?.focus()
      search.current?.select()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [])
  const active = hasActiveFilters(filters)
  return (
    <div role="search" aria-label={t.filters} className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <div className="relative w-full sm:w-72">
        <SearchIcon aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-faint-foreground" />
        <Input
          ref={search}
          type="search"
          aria-label={t.searchLabel}
          placeholder={t.searchPlaceholder}
          value={filters.query}
          onChange={(e) => onChange({ ...filters, query: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Escape" && filters.query) {
              e.preventDefault()
              onChange({ ...filters, query: "" })
            }
          }}
          className="pr-9 pl-8 [&::-webkit-search-cancel-button]:hidden"
        />
        <Kbd aria-hidden className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 max-sm:hidden">/</Kbd>
      </div>
      {templates.length > 1 ? (
        <div
          ref={chipScroller}
          className={cn(
            "-mx-1 max-w-full overflow-x-auto px-1 [scrollbar-width:none]",
            chipEdges.start && chipEdges.end ? FADE_MASK.both : chipEdges.end ? FADE_MASK.end : chipEdges.start ? FADE_MASK.start : null,
          )}
        >
          <SegmentedControl<string>
            size="sm"
            aria-label={t.templateGroup}
            value={filters.template ?? "all"}
            onChange={(v) => onChange({ ...filters, template: v === "all" ? null : v })}
            options={[
              { value: "all", label: t.allTemplates },
              ...templates.map((o) => ({
                value: o.value,
                label: <>{o.label}<span className="font-mono text-micro text-faint-foreground tabular-nums">{o.count}</span></>,
                ariaLabel: `${o.label} (${o.count})`,
              })),
            ]}
          />
        </div>
      ) : null}
      <ToggleGroup
        type="single"
        size="sm"
        aria-label={t.reservationFilter}
        value={filters.only === "all" ? "" : filters.only}
        onValueChange={(v) => onChange({ ...filters, only: (v || "all") as OnlyFilter })}
      >
        <ToggleGroupItem value="mine">{t.onlyMine}</ToggleGroupItem>
        <ToggleGroupItem value="free">{t.onlyFree}</ToggleGroupItem>
      </ToggleGroup>
      {active ? (
        <div className="flex items-center gap-2 sm:ml-auto">
          <span className="text-meta text-muted-foreground tabular-nums" aria-live="polite">{t.results(shown, cards.length)}</span>
          <Button size="sm" variant="ghost" onClick={() => onChange(defaultFilters())}>
            <XIcon aria-hidden />
            {t.clearFilters}
          </Button>
        </div>
      ) : null}
    </div>
  )
}

const SETUP_ALERT_EVENT = "rm-banco-setup-alert"

function readSetupDismissed(): boolean {
  try {
    return window.sessionStorage.getItem(SETUP_ALERT_KEY) === "1"
  } catch {
    return false
  }
}
function subscribeSetupDismissed(cb: () => void): () => void {
  window.addEventListener(SETUP_ALERT_EVENT, cb)
  return () => window.removeEventListener(SETUP_ALERT_EVENT, cb)
}

/** Dismissible for the browser session; 24 h after the first-run setup, admins only (§8.9). */
function SetupAlert() {
  // Hidden on the server and during hydration (the dismissal lives in this tab's sessionStorage).
  const dismissed = React.useSyncExternalStore(subscribeSetupDismissed, readSetupDismissed, () => true)
  const setDismissed = (v: boolean) => {
    try {
      window.sessionStorage.setItem(SETUP_ALERT_KEY, v ? "1" : "0")
    } catch {
      // Not remembered: the alert comes back on the next page load.
    }
    window.dispatchEvent(new Event(SETUP_ALERT_EVENT))
  }
  if (dismissed) return null
  return (
    <InlineAlert
      tone="info"
      className="max-sm:flex-wrap"
      actions={(
        <>
          <Button size="sm" asChild><AppLink href="/sistema/salud">{t.setupAlertLink}</AppLink></Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t.dismiss}
            onClick={() => setDismissed(true)}
          >
            <XIcon aria-hidden />
          </Button>
        </>
      )}
    >
      {t.setupAlert}
    </InlineAlert>
  )
}

/**
 * Banco (§8.9): header with the live summary and "Nuevo equipo" (admins), the filter bar and the unit grid
 * (`repeat(auto-fill, minmax(340px, 1fr))`, gap 12). Cards update in place from SSE (`reservation.changed`,
 * `console.status`, `console.activity`, `relay.state`); `equipment.changed` refreshes the page (debounced 300 ms).
 */
export function BancoView({ cards: serverCards, showSetupAlert, equipnet = null }: { cards: EquipmentCardDTO[]; showSetupAlert: boolean; equipnet?: EquipnetStatusDTO | null }) {
  const router = useRouter()
  const { shell } = useShell()
  const viewer = shell.viewer
  const stale = useStale()
  const cards = useLiveState(serverCards, BANCO_EVENTS, reduceCards)
  const unassigned = useLiveState(shell.unassignedPorts, SERIAL_EVENTS, (v, e) => (e.type === "serial.changed" ? countUnassigned(e.snapshot) : v))
  const [filters, setFilters] = React.useState<BancoFilters>(defaultFilters)

  const refreshTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  useServerEvents(["equipment.changed"], () => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current)
    refreshTimer.current = setTimeout(() => router.refresh(), REFRESH_DEBOUNCE_MS)
  })
  React.useEffect(() => () => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current)
  }, [])

  const shown = filterCards(cards, filters, viewer.id)
  const counts = bancoCounts(cards)
  const newButton = viewer.isAdmin ? (
    <Button variant="primary" asChild>
      <AppLink href="/equipos/nuevo"><PlusIcon aria-hidden />{t.newEquipment}</AppLink>
    </Button>
  ) : null

  return (
    <Page className="gap-4">
      <PageHeader title={t.title} summary={cards.length ? summaryText(counts) : null} actions={cards.length ? newButton : null} />
      {showSetupAlert && viewer.isAdmin ? <SetupAlert /> : null}
      {viewer.isAdmin ? <EquipnetOfferCard status={equipnet} /> : null}
      {!cards.length ? (
        viewer.isAdmin ? (
          <EmptyState
            icon={ServerIcon}
            title={t.emptyAdminTitle}
            actions={(
              <>
                {newButton}
                {unassigned ? (
                  <Button asChild>
                    <AppLink href="/descubrimiento"><PlugIcon aria-hidden />{t.emptyAdminPorts(unassigned)}</AppLink>
                  </Button>
                ) : null}
              </>
            )}
          >
            {t.emptyAdminBody}
          </EmptyState>
        ) : (
          <EmptyState icon={ServerIcon} title={t.emptyUserTitle}>{t.emptyUserBody}</EmptyState>
        )
      ) : (
        <>
          <BancoFilterBar cards={cards} filters={filters} onChange={setFilters} shown={shown.length} />
          {shown.length ? (
            <div className={cn("grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(min(340px,100%),1fr))]")}>
              {shown.map((c) => (
                <EquipmentUnit key={c.id} card={c} viewer={viewer} warningMin={shell.reservationWarningMin} stale={stale} />
              ))}
            </div>
          ) : (
            <EmptyState
              icon={SearchIcon}
              title={t.noMatches}
              actions={<Button onClick={() => setFilters(defaultFilters())}><XIcon aria-hidden />{t.clearFilters}</Button>}
            >
              {t.noMatchesHint}
            </EmptyState>
          )}
        </>
      )}
    </Page>
  )
}
