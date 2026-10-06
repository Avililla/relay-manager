"use client"

import * as React from "react"
import { PlusIcon, RadarIcon, ToggleRightIcon } from "lucide-react"
import { AppLink } from "@/components/common/app-link"
import { DataTable, type DataColumn } from "@/components/common/data-table"
import { EmptyState } from "@/components/common/empty-state"
import { Page, PageHeader } from "@/components/common/page"
import { RelativeTime } from "@/components/common/relative-time"
import { PageMeta } from "@/components/shell/page-meta"
import { Button } from "@/components/ui/button"
import { useLiveState } from "@/hooks/use-live-state"
import type { ServerEventType } from "@/lib/contracts/events"
import type { BoardDTO } from "@/lib/contracts/relays"
import { boards as t, hardwarePages } from "@/lib/i18n/hardware"
import { driverLabel } from "@/lib/i18n/status"
import { boardStatusKind } from "@/lib/relays/status"
import { BoardStatusChip } from "./board-status-chip"
import { applyBoardStatus, boardHttpAddress, boardTcpPort } from "./board-view"

const EVENTS: readonly ServerEventType[] = ["board.status"]

const COLUMNS: ReadonlyArray<DataColumn<BoardDTO>> = [
  {
    id: "name",
    header: t.colName,
    cell: (b) => <AppLink href={`/placas/${b.id}`} className="font-medium text-foreground hover:text-brand hover:underline underline-offset-4">{b.name}</AppLink>,
    sortValue: (b) => b.name,
    searchValue: (b) => `${b.name} ${b.mac ?? ""}`,
  },
  {
    id: "model",
    header: t.colModel,
    cell: (b) => (b.model ? <span className="font-mono text-data">{b.model}</span> : <span className="text-faint-foreground">{t.notSet}</span>),
    sortValue: (b) => b.model,
    searchValue: (b) => b.model ?? "",
  },
  {
    id: "address",
    header: t.colAddress,
    cell: (b) => {
      const tcp = boardTcpPort(b)
      return (
        <span className="flex flex-col font-mono text-data leading-tight whitespace-nowrap tabular-nums">
          <span>{boardHttpAddress(b)}</span>
          {tcp ? <span className="text-muted-foreground">{t.tcp(tcp)}</span> : null}
        </span>
      )
    },
    sortValue: (b) => b.host,
    searchValue: (b) => `${b.host}:${b.httpPort}`,
  },
  { id: "driver", header: t.colDriver, cell: (b) => <span className="whitespace-nowrap">{driverLabel(b.driver)}</span>, sortValue: (b) => driverLabel(b.driver) },
  {
    id: "relays",
    header: t.colRelays,
    align: "right",
    cell: (b) => (
      <span title={t.colRelaysHint} className="font-mono text-data">
        <span aria-hidden>{t.relaysUsed(b.usedChannels, b.relayCount)}</span>
        <span className="sr-only">{t.relaysUsedLabel(b.usedChannels, b.relayCount)}</span>
      </span>
    ),
    sortValue: (b) => b.usedChannels,
  },
  {
    id: "status",
    header: t.colStatus,
    cell: (b) => <BoardStatusChip board={b} quiet={boardStatusKind(b) === "online"} />,
    sortValue: (b) => ["online", "never", "offline", "disabled"].indexOf(boardStatusKind(b)),
  },
  {
    id: "lastRead",
    header: t.colLastRead,
    cell: (b) => (b.runtime.lastSeenAt ? <RelativeTime value={b.runtime.lastSeenAt} className="text-muted-foreground" /> : <span className="text-faint-foreground">{t.never}</span>),
    sortValue: (b) => b.runtime.lastSeenAt,
  },
]

/** Placas de relés list (§8.9): live status from `board.status`, and a teaching empty state with 0 boards. */
export function BoardsList({ boards }: { boards: BoardDTO[] }) {
  const live = useLiveState(boards, EVENTS, applyBoardStatus)
  const counts = { online: 0, offline: 0, disabled: 0 }
  for (const b of live) {
    const k = boardStatusKind(b)
    if (k === "online") counts.online++
    else if (k === "offline") counts.offline++
    else if (k === "disabled") counts.disabled++
  }
  const actions = (
    <>
      <Button asChild variant="default">
        <AppLink href="/descubrimiento?tab=reles"><RadarIcon aria-hidden />{t.searchBoards}</AppLink>
      </Button>
      <Button asChild variant="primary">
        <AppLink href="/placas/nueva"><PlusIcon aria-hidden />{live.length ? t.addBoard : t.addManual}</AppLink>
      </Button>
    </>
  )
  return (
    <Page>
      <PageMeta breadcrumbs={[{ label: hardwarePages.boards }]} />
      <PageHeader
        title={t.title}
        summary={live.length ? t.summary(live.length, counts.online, counts.offline, counts.disabled) : undefined}
        actions={live.length ? actions : undefined}
      />
      {live.length ? (
        <>
          <DataTable
            rows={live}
            columns={COLUMNS}
            rowKey={(b) => b.id}
            rowHref={(b) => `/placas/${b.id}`}
            search={live.length > 5}
            searchPlaceholder={t.searchPlaceholder}
            initialSort={{ id: "name", dir: "asc" }}
            caption={t.caption}
            className="max-md:hidden"
          />
          {/* Below 768 px: one row per board with the name as the tap target and the status next to it. */}
          <ul aria-label={t.caption} className="flex flex-col divide-y rounded-lg border bg-card md:hidden">
            {[...live].sort((a, b) => a.name.localeCompare(b.name, "es", { numeric: true })).map((b) => {
              const tcp = boardTcpPort(b)
              return (
                <li key={b.id} className="flex min-w-0 flex-col gap-1.5 px-3 py-2.5">
                  <div className="flex items-center justify-between gap-3">
                    <AppLink href={`/placas/${b.id}`} className="min-w-0 truncate font-medium text-foreground underline-offset-4 hover:underline">{b.name}</AppLink>
                    <BoardStatusChip board={b} quiet={boardStatusKind(b) === "online"} className="shrink-0" />
                  </div>
                  <div className="flex flex-wrap gap-x-2 font-mono text-data text-muted-foreground tabular-nums">
                    {b.model ? <span>{b.model}</span> : null}
                    <span>{boardHttpAddress(b)}</span>
                    {tcp ? <span>{t.tcp(tcp)}</span> : null}
                  </div>
                  <div className="flex flex-wrap gap-x-3 text-meta text-muted-foreground">
                    <span>{driverLabel(b.driver)}</span>
                    <span className="tabular-nums">{t.relaysUsedLabel(b.usedChannels, b.relayCount)}</span>
                  </div>
                </li>
              )
            })}
          </ul>
        </>
      ) : (
        <EmptyState icon={ToggleRightIcon} title={t.emptyTitle} actions={actions}>
          {t.emptyBody}
        </EmptyState>
      )}
    </Page>
  )
}
