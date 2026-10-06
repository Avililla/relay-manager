"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { DownloadIcon, SlidersHorizontalIcon, XIcon } from "lucide-react"
import { toast } from "sonner"
import { AuditTable } from "@/components/common/audit-table"
import type { ComboOption } from "@/components/common/combobox"
import { Page, PageHeader } from "@/components/common/page"
import { firstVisible, focusWhenLost } from "@/components/discovery/focus"
import { PageMeta } from "@/components/shell/page-meta"
import { Button } from "@/components/ui/button"
import type { AuditEventDTO, AuditQuery } from "@/lib/contracts/audit"
import type { Page as PageOf } from "@/lib/contracts/common"
import { auditPage as t, hardwarePages } from "@/lib/i18n/hardware"
import { common } from "@/lib/i18n/shell"
import { loginRedirect } from "@/lib/client/action-result"
import { cn } from "@/lib/client/cn"
import { activeFilterCount, auditApiSearch, auditFiltersSearch, DEFAULT_AUDIT_FILTERS, hasActiveFilters, type AuditFilters } from "./audit-filters"
import { AuditCards } from "./audit-cards"
import { AuditFilterBar } from "./audit-filter-bar"

/**
 * Auditoría (§8.9): URL filters rendered on the server, "Cargar más" through GET /api/audit, and the CSV export of
 * the current filters.
 */
export function AuditView({ filters, query, page, users, equipment, retentionDays }: {
  filters: AuditFilters
  query: AuditQuery
  page: PageOf<AuditEventDTO>
  users: ComboOption[]
  equipment: ComboOption[]
  retentionDays: number
}) {
  const router = useRouter()
  const [navigating, startNavigation] = React.useTransition()
  const [filtersOpen, setFiltersOpen] = React.useState(false)
  const search = auditFiltersSearch(filters)
  const exportHref = `/api/audit/export${auditApiSearch(query)}`

  const navigate = (next: AuditFilters) => {
    startNavigation(() => router.push(`/auditoria${auditFiltersSearch(next)}`, { scroll: false }))
  }
  // "Borrar filtros" disappears with the new result set: land on the results line, which reads the new count.
  const clearFilters = () => {
    navigate(DEFAULT_AUDIT_FILTERS)
    focusWhenLost(() => firstVisible("[data-audit-results]"))
  }

  return (
    <Page>
      <PageMeta breadcrumbs={[{ label: hardwarePages.audit }]} />
      <PageHeader
        title={t.title}
        summary={t.retention(retentionDays)}
        actions={(
          <Button asChild variant="default" title={t.exportHint}>
            <a href={exportHref} download>
              <DownloadIcon aria-hidden />
              {t.exportCsv}
            </a>
          </Button>
        )}
      />
      <Button
        variant="default"
        className="w-fit md:hidden"
        aria-expanded={filtersOpen}
        aria-controls="audit-filters"
        onClick={() => setFiltersOpen((o) => !o)}
      >
        <SlidersHorizontalIcon aria-hidden />
        {t.filtersToggle(activeFilterCount(filters))}
      </Button>
      <AuditFilterBar
        id="audit-filters"
        filters={filters}
        users={users}
        equipment={equipment}
        onChange={navigate}
        className={filtersOpen ? undefined : "max-md:hidden"}
      />
      {/* Keyed by the filters: a new filter set starts from the server's first page. */}
      <AuditLog
        key={search}
        page={page}
        query={query}
        busy={navigating}
        emptyAction={hasActiveFilters(filters) ? clearFilters : null}
      />
    </Page>
  )
}

function AuditLog({ page, query, busy, emptyAction }: {
  page: PageOf<AuditEventDTO>
  query: AuditQuery
  busy: boolean
  emptyAction: (() => void) | null
}) {
  const [items, setItems] = React.useState(page.items)
  const [cursor, setCursor] = React.useState(page.nextCursor)
  const [loading, setLoading] = React.useState(false)
  const [exhausted, setExhausted] = React.useState(false)

  const loadMore = async () => {
    if (!cursor || loading) return
    setLoading(true)
    try {
      const res = await fetch(`/api/audit${auditApiSearch(query, cursor)}`, { cache: "no-store", headers: { accept: "application/json" } })
      if (res.status === 401) {
        window.location.assign(loginRedirect(window.location.pathname + window.location.search))
        return
      }
      if (!res.ok) throw new Error(String(res.status))
      const next = (await res.json()) as PageOf<AuditEventDTO>
      setItems((prev) => {
        const seen = new Set(prev.map((e) => e.id))
        return [...prev, ...next.items.filter((e) => !seen.has(e.id))]
      })
      setCursor(next.nextCursor)
      if (!next.nextCursor) {
        // The button goes away with the last page: focus the end note in its place (no jump to the top).
        setExhausted(true)
        focusWhenLost(() => firstVisible("[data-audit-end]"), 2000)
      }
    } catch {
      toast.error(t.loadMoreError)
    } finally {
      setLoading(false)
    }
  }

  const empty = (
    <span className="flex flex-wrap items-center gap-3">
      {emptyAction ? t.empty : t.emptyAll}
      {emptyAction ? (
        <Button variant="ghost" size="sm" onClick={emptyAction}>
          <XIcon aria-hidden />
          {t.clearFilters}
        </Button>
      ) : null}
    </span>
  )

  return (
    <div aria-busy={busy || undefined} className={cn("flex min-w-0 flex-col gap-2 transition-opacity duration-150 ease-(--ease-out)", busy && "opacity-60")}>
      <div className="flex min-h-7 flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <p data-audit-results tabIndex={-1} className="text-meta text-muted-foreground tabular-nums" aria-live="polite">
          {busy ? t.loading : items.length ? t.shown(items.length, cursor !== null) : null}
        </p>
        {emptyAction && items.length ? (
          <Button variant="ghost" size="sm" onClick={emptyAction}>
            <XIcon aria-hidden />
            {t.clearFilters}
          </Button>
        ) : null}
      </div>
      {/* Table from 768 px, one card per event below. "Cargar más" is ours for both (it keeps focus while loading). */}
      <AuditTable events={items} showIp empty={empty} className="max-md:hidden" />
      <AuditCards events={items} empty={empty} className="md:hidden" />
      {cursor ? (
        <div className="pt-1">
          <Button pending={loading} onClick={() => void loadMore()}>
            {loading ? common.loadingMore : common.loadMore}
          </Button>
        </div>
      ) : exhausted ? (
        <p data-audit-end tabIndex={-1} className="w-fit pt-1 text-meta text-muted-foreground">{t.allLoaded}</p>
      ) : null}
    </div>
  )
}
