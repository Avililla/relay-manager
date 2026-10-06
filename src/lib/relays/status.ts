// Board and relay state labels (§8.6: icon + Spanish label + colour, never colour alone). Pure, UI-safe.
import type { BoardRuntimeDTO } from "@/lib/contracts/relays"
import { RELAY_TEXT } from "@/lib/i18n/relays"

export type BoardStatusKind = "online" | "offline" | "never" | "disabled"

export function boardStatusKind(board: { enabled: boolean; runtime: Pick<BoardRuntimeDTO, "online"> }): BoardStatusKind {
  if (!board.enabled) return "disabled"
  if (board.runtime.online === null) return "never"
  return board.runtime.online ? "online" : "offline"
}

/** "Conectada" / "Sin respuesta desde 13:02" / "Sin leer todavía" / "Desactivada". `formatWhen` formats lastSeenAt. */
export function boardStatusLabel(
  board: { enabled: boolean; runtime: Pick<BoardRuntimeDTO, "online" | "lastSeenAt"> },
  formatWhen: (iso: string) => string,
): string {
  switch (boardStatusKind(board)) {
    case "disabled": return RELAY_TEXT.boardDisabled
    case "never": return RELAY_TEXT.boardNeverPolled
    case "online": return RELAY_TEXT.boardOnline
    case "offline": return board.runtime.lastSeenAt ? RELAY_TEXT.boardOfflineSince(formatWhen(board.runtime.lastSeenAt)) : RELAY_TEXT.boardOffline
  }
}

/** "ON" / "OFF" / "?" (unknown or stale-without-value). */
export function relayStateText(on: boolean | null): string {
  return on === null ? RELAY_TEXT.stateUnknown : on ? RELAY_TEXT.stateOn : RELAY_TEXT.stateOff
}

/** Channels of a board that are free (1..relayCount minus the used ones). */
export function freeChannels(relayCount: number, used: Iterable<number>): number[] {
  const u = new Set(used)
  return Array.from({ length: relayCount }, (_, i) => i + 1).filter((c) => !u.has(c))
}
