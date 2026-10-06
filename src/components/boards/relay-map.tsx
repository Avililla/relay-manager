"use client"

import * as React from "react"
import { ClockIcon } from "lucide-react"
import { AppLink } from "@/components/common/app-link"
import { useStale } from "@/hooks/use-server-events"
import { useMounted } from "@/hooks/use-mounted"
import type { BoardDetailDTO } from "@/lib/contracts/relays"
import { formatTime } from "@/lib/i18n/format"
import { boards as t } from "@/lib/i18n/hardware"
import { RELAY_TEXT } from "@/lib/i18n/relays"
import { cn } from "@/lib/client/cn"
import { relayTiles, type TileState } from "./board-view"

const STATE_TEXT: Record<TileState, string> = { on: RELAY_TEXT.stateOn, off: RELAY_TEXT.stateOff, unknown: RELAY_TEXT.stateUnknown }
const STATE_SR: Record<TileState, string> = { on: t.stateOnLabel, off: t.stateOffLabel, unknown: t.stateUnknownLabel }

/**
 * Read-only relay state (§8.6): a text badge, not a switch or a checkbox (nothing on this map is clickable). ON is an
 * --ok fill, OFF a neutral outline, "?" a neutral hatch: the same badge Banco uses for read-only relay states.
 */
function StateBadge({ state }: { state: TileState }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex h-5 min-w-9 shrink-0 items-center justify-center rounded-sm px-1.5 font-mono text-micro font-medium tabular-nums",
        state === "on" && "bg-ok text-card",
        state === "off" && "border border-control-border text-muted-foreground",
        state === "unknown" && "hatch border border-control-border text-foreground",
      )}
    >
      {/* The "?" sits on a solid patch so the hatch never hides it. */}
      {state === "unknown" ? <span className="rounded-[2px] bg-card px-1 leading-none font-semibold">{STATE_TEXT[state]}</span> : STATE_TEXT[state]}
    </span>
  )
}

/**
 * The board's relay map (§8.9): channels 1..N in a grid; each tile shows "Canal N", the state and the binding
 * ("equipo · etiqueta", linking to the equipment) or "Libre". Occupancy is carried by text and the border pattern
 * (solid = bound, dashed = free), never by hue. Read-only.
 */
export function RelayMap({ board }: { board: BoardDetailDTO }) {
  const connectionStale = useStale()
  const mounted = useMounted()
  const tiles = relayTiles(board, connectionStale)
  const staleNote = connectionStale
    ? t.mapStaleConnection
    : board.enabled && (board.runtime.stale || board.runtime.online === false)
      ? t.mapStale(mounted && board.runtime.lastSeenAt ? formatTime(board.runtime.lastSeenAt) : null)
      : null
  return (
    <div className="flex flex-col gap-3">
      {staleNote ? (
        <p className="flex items-center gap-1.5 text-meta text-faint-foreground">
          <ClockIcon aria-hidden className="size-3.5" />
          {staleNote}
        </p>
      ) : null}
      <ul aria-label={t.mapTitle} className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-2">
        {tiles.map((tile) => (
          <li
            key={tile.channel}
            className={cn(
              "flex min-h-22 min-w-0 flex-col justify-between gap-2 rounded-lg border p-2.5",
              tile.bound ? "border-solid border-border bg-card" : "border-dashed border-control-border bg-transparent",
            )}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-micro text-muted-foreground">
                {RELAY_TEXT.channelLabel(tile.channel)}
              </span>
              <StateBadge state={tile.state} />
              <span className="sr-only">{STATE_SR[tile.state]}</span>
            </div>
            {tile.bound && tile.equipmentId ? (
              <AppLink
                href={`/equipos/${tile.equipmentId}`}
                className="line-clamp-2 text-meta text-foreground underline-offset-4 hover:text-brand hover:underline"
              >
                {tile.bindingText}
              </AppLink>
            ) : (
              <span className="text-meta text-faint-foreground">{t.channelFree}</span>
            )}
          </li>
        ))}
      </ul>
      <p className="flex flex-wrap gap-x-4 gap-y-1 text-meta text-muted-foreground">
        <span className="inline-flex items-center gap-1.5"><span aria-hidden className="inline-block h-3.5 w-6 rounded-[3px] border bg-card" />{t.mapLegendBound}</span>
        <span className="inline-flex items-center gap-1.5"><span aria-hidden className="inline-block h-3.5 w-6 rounded-[3px] border border-dashed border-control-border" />{t.mapLegendFree}</span>
      </p>
    </div>
  )
}
