// Console runtime from two live sources (SSE `console.status`/`console.activity` and the console socket's
// `hello`/`status`) and viewer presence for the status bar. Pure and unit-tested.
import type { ServerEvent } from "@/lib/contracts/events"
import type { ConsoleRuntimeDTO } from "@/lib/contracts/serial"
import type { ViewerPresenceDTO } from "@/lib/contracts/ws"
import { workspace as t } from "@/lib/i18n/banco"

const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) : Number.NaN)

export const CONSOLE_EVENTS = ["console.status", "console.activity"] as const

/** SSE deltas for the workspace's console list; the same array back when nothing changed. */
export function reduceConsoleList<C extends { id: string; runtime: ConsoleRuntimeDTO }>(list: readonly C[], e: ServerEvent, equipmentId: string): C[] {
  if ((e.type !== "console.status" && e.type !== "console.activity") || e.equipmentId !== equipmentId) return list as C[]
  if (!list.some((c) => c.id === e.consoleId)) return list as C[]
  return list.map((c) => {
    if (c.id !== e.consoleId) return c
    if (e.type === "console.status") return { ...c, runtime: e.runtime }
    return { ...c, runtime: { ...c.runtime, lastLine: e.lastLine, lastRxAt: e.lastRxAt } }
  })
}

/**
 * The newer status (by `since`; the socket wins a tie) with the latest activity (`lastRxAt`/`lastLine`) from
 * either source. SSE carries activity; the socket carries status even when the SSE stream is down.
 */
export function mergeRuntime(sse: ConsoleRuntimeDTO, socket: ConsoleRuntimeDTO | null): ConsoleRuntimeDTO {
  if (!socket) return sse
  const base = ms(socket.since) >= ms(sse.since) || !Number.isFinite(ms(sse.since)) ? socket : sse
  const act = ms(sse.lastRxAt) >= ms(socket.lastRxAt) || !Number.isFinite(ms(socket.lastRxAt)) ? sse : socket
  if (base === act) return base
  return { ...base, lastRxAt: act.lastRxAt, lastLine: act.lastLine }
}

/** One entry per person; a person with any `rw` session counts as writing. */
export function distinctViewers(list: readonly ViewerPresenceDTO[]): ViewerPresenceDTO[] {
  const by = new Map<string, ViewerPresenceDTO>()
  for (const v of list) {
    const prev = by.get(v.userId)
    if (!prev || (prev.mode === "ro" && v.mode === "rw")) by.set(v.userId, prev ? { ...prev, mode: "rw" } : v)
  }
  return [...by.values()]
}

export interface ViewersLine { key: string; count: number; names: string[] }

export function viewersSummary(consoles: ReadonlyArray<{ key: string; viewers: readonly ViewerPresenceDTO[] }>): ViewersLine[] {
  return consoles
    .map((c) => {
      const people = distinctViewers(c.viewers)
      return { key: c.key, count: people.length, names: people.map((p) => (p.mode === "rw" ? t.viewerWriting(p.name) : p.name)) }
    })
    .filter((l) => l.count > 0)
}
