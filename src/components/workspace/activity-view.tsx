"use client"

import * as React from "react"
import { AuditTable } from "@/components/common/audit-table"
import { InlineAlert } from "@/components/common/inline-alert"
import { Button } from "@/components/ui/button"
import type { AuditEventDTO } from "@/lib/contracts/audit"
import type { Page } from "@/lib/contracts/common"
import { activity as t } from "@/lib/i18n/banco"
import { pages } from "@/lib/i18n/shell"

/**
 * Equipo "Actividad" tab (§8.9): the server renders the first page of `getEquipmentActivity`; "Cargar más" fetches
 * `GET /api/equipment/<id>/activity?cursor=` and appends. Non-admins get no IPs (the server hides them).
 */
export function ActivityView({ equipmentId, initial, showIp }: { equipmentId: string; initial: Page<AuditEventDTO>; showIp: boolean }) {
  const [base, setBase] = React.useState(initial)
  const [extra, setExtra] = React.useState<AuditEventDTO[]>([])
  const [cursor, setCursor] = React.useState<string | null>(initial.nextCursor)
  const [loading, setLoading] = React.useState(false)
  const [failed, setFailed] = React.useState(false)
  // A new server render (router.refresh) restarts the list from its first page.
  if (base !== initial) {
    setBase(initial)
    setExtra([])
    setCursor(initial.nextCursor)
    setFailed(false)
  }

  const loadMore = async () => {
    if (!cursor || loading) return
    setLoading(true)
    setFailed(false)
    try {
      const res = await fetch(`/api/equipment/${encodeURIComponent(equipmentId)}/activity?cursor=${encodeURIComponent(cursor)}`, { cache: "no-store" })
      if (res.status === 401) {
        window.location.assign("/login")
        return
      }
      if (!res.ok) throw new Error(String(res.status))
      const page = (await res.json()) as Page<AuditEventDTO>
      setExtra((prev) => {
        const seen = new Set([...initial.items, ...prev].map((e) => e.id))
        return [...prev, ...page.items.filter((e) => !seen.has(e.id))]
      })
      setCursor(page.nextCursor)
    } catch {
      setFailed(true)
    } finally {
      setLoading(false)
    }
  }

  const events = [...initial.items, ...extra]
  return (
    <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-3 px-4 py-4 md:px-6 md:py-5">
      <div className="flex flex-col gap-0.5">
        <h2 className="text-section text-foreground">{t.title}</h2>
        <p className="max-w-[72ch] text-meta text-muted-foreground">{t.description}</p>
      </div>
      <AuditTable
        events={events}
        showIp={showIp}
        showEquipment={false}
        empty={t.empty}
        onLoadMore={cursor ? () => void loadMore() : undefined}
        loadingMore={loading}
      />
      {failed ? (
        <InlineAlert tone="danger" role="alert" actions={<Button size="sm" onClick={() => void loadMore()}>{pages.retry}</Button>}>
          {t.loadError}
        </InlineAlert>
      ) : null}
      {!cursor && events.length > 0 && extra.length > 0 ? <p className="text-meta text-muted-foreground">{t.end}</p> : null}
    </div>
  )
}
