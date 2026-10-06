// Placas de relés list and detail (§8.6, §8.9): status chip, addresses, capabilities and the relay map tiles. Pure.
import { CircleCheckIcon, CircleDashedIcon, CirclePauseIcon, TriangleAlertIcon, type LucideIcon } from "lucide-react"
import type { ServerEvent } from "@/lib/contracts/events"
import type { BoardDetailDTO, BoardDTO, BoardRuntimeDTO } from "@/lib/contracts/relays"
import { effectiveTcpPort } from "@/lib/relays/capabilities"
import { boardStatusKind, boardStatusLabel, type BoardStatusKind } from "@/lib/relays/status"

export interface BoardStatusView { kind: BoardStatusKind; tone: "ok" | "danger" | "neutral"; icon: LucideIcon; label: string }

const ICON: Record<BoardStatusKind, { tone: BoardStatusView["tone"]; icon: LucideIcon }> = {
  online: { tone: "ok", icon: CircleCheckIcon },
  offline: { tone: "danger", icon: TriangleAlertIcon },
  never: { tone: "neutral", icon: CircleDashedIcon },
  disabled: { tone: "neutral", icon: CirclePauseIcon },
}

/** "Conectada" / "Sin respuesta desde 13:02" / "Sin leer todavía" / "Desactivada", with its icon and tone. */
export function boardStatusView(b: Pick<BoardDTO, "enabled" | "runtime">, formatWhen: (iso: string) => string): BoardStatusView {
  const kind = boardStatusKind(b)
  return { kind, ...ICON[kind], label: boardStatusLabel(b, formatWhen) }
}

/** "127.0.0.22:18180". */
export function boardHttpAddress(b: Pick<BoardDTO, "host" | "httpPort">): string {
  return `${b.host}:${b.httpPort}`
}

/** The TCP port the driver really uses (explicit or the driver default), or null for HTTP-only drivers. */
export function boardTcpPort(b: Pick<BoardDTO, "driver" | "tcpPort">): number | null {
  return effectiveTcpPort(b.driver, b.tcpPort)
}

/** Applies a `board.status` event to a board list (other boards keep their identity). */
export function applyBoardStatus<T extends { id: string; runtime: BoardRuntimeDTO }>(list: readonly T[], e: ServerEvent): T[] {
  if (e.type !== "board.status") return list as T[]
  let changed = false
  const next = list.map((b) => {
    if (b.id !== e.boardId) return b
    changed = true
    return { ...b, runtime: e.runtime }
  })
  return changed ? next : (list as T[])
}

/** Applies a `board.status` event to one board detail: the runtime and each channel's state. */
export function applyBoardDetailStatus(b: BoardDetailDTO, e: ServerEvent): BoardDetailDTO {
  if (e.type !== "board.status" || e.boardId !== b.id) return b
  return { ...b, runtime: e.runtime, channels: b.channels.map((c) => ({ ...c, state: e.runtime.states[c.channel - 1] ?? null })) }
}

export type TileState = "on" | "off" | "unknown"

export interface RelayTileView {
  channel: number
  state: TileState
  bound: boolean
  equipmentId: string | null
  bindingText: string | null
}

/**
 * One tile of the relay map. With a stale runtime (the board did not answer) or no live connection the state shows
 * "?" (§8.9 stale style); the last known value is not presented as current.
 */
export function relayTiles(b: Pick<BoardDetailDTO, "channels" | "runtime" | "enabled">, connectionStale: boolean): RelayTileView[] {
  const unknown = connectionStale || b.runtime.stale || !b.enabled || b.runtime.online === false
  return b.channels.map((c) => ({
    channel: c.channel,
    state: unknown || c.state === null ? "unknown" : c.state ? "on" : "off",
    bound: c.binding !== null,
    equipmentId: c.binding?.equipmentId ?? null,
    bindingText: c.binding ? `${c.binding.equipmentName} · ${c.binding.label}` : null,
  }))
}

/** Distinct equipment that use a board (for the delete confirmation). */
export function boardUsage(b: Pick<BoardDetailDTO, "channels">): { relays: number; equipment: number } {
  const bound = b.channels.filter((c) => c.binding !== null)
  return { relays: bound.length, equipment: new Set(bound.map((c) => c.binding?.equipmentId)).size }
}
