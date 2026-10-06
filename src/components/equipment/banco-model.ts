// Banco pure logic (§8.9 Banco): unit summary precedence, header counts, filters and live SSE deltas.
// Pure and unit-tested; the components only render what these functions decide.
import type { ConsoleStatus } from "@/lib/contracts/enums"
import type { EquipmentCardDTO } from "@/lib/contracts/equipment"
import type { ServerEvent } from "@/lib/contracts/events"
import { RECEIVING_WINDOW_MS } from "@/components/serial/console-status"
import { banco } from "@/lib/i18n/banco"

/** Unit summary on Banco (§8.6): danger > reserved by other > reserved by me > active > idle. */
export type UnitSummaryKind = "danger" | "other" | "mine" | "active" | "idle"

const DANGER_CONSOLE: ReadonlySet<ConsoleStatus> = new Set(["missing", "no-permission", "error"])

type SummaryInput = Pick<EquipmentCardDTO, "consoles" | "relays" | "reservation">

export function hasIncidents(card: SummaryInput): boolean {
  return card.consoles.some((c) => DANGER_CONSOLE.has(c.runtime.status)) || card.relays.some((r) => r.boardOnline === false)
}

export function isReceiving(card: Pick<EquipmentCardDTO, "consoles">, now: number): boolean {
  return card.consoles.some((c) => {
    if (c.runtime.status !== "open" || !c.runtime.lastRxAt) return false
    const t = Date.parse(c.runtime.lastRxAt)
    return Number.isFinite(t) && now - t < RECEIVING_WINDOW_MS
  })
}

export function unitSummary(card: SummaryInput, viewerId: string, now: number): UnitSummaryKind {
  if (hasIncidents(card)) return "danger"
  if (card.reservation && card.reservation.holderId !== viewerId) return "other"
  if (card.reservation) return "mine"
  return isReceiving(card, now) ? "active" : "idle"
}

export interface BancoCounts { total: number; reserved: number; incidents: number }

export function bancoCounts(cards: readonly EquipmentCardDTO[]): BancoCounts {
  return {
    total: cards.length,
    reserved: cards.filter((c) => c.reservation !== null).length,
    incidents: cards.filter((c) => hasIncidents(c)).length,
  }
}

/** "12 equipos · 3 reservados · 1 con incidencias"; zero parts after the total are left out. */
export function summaryText(c: BancoCounts): string {
  const parts = [banco.summaryEquipos(c.total)]
  if (c.reserved) parts.push(banco.summaryReserved(c.reserved))
  if (c.incidents) parts.push(banco.summaryIncidents(c.incidents))
  return parts.join(" · ")
}

// ── Filters ────────────────────────────────────────────────────────────────────────────────────────────────────

export type OnlyFilter = "all" | "mine" | "free"
/** `template`: null = "Todas"; "t:<name>" for a template; "none" for units without a template. */
export interface BancoFilters { template: string | null; query: string; only: OnlyFilter }

export function defaultFilters(): BancoFilters {
  return { template: null, query: "", only: "all" }
}

export function hasActiveFilters(f: BancoFilters): boolean {
  return f.template !== null || f.query.trim() !== "" || f.only !== "all"
}

/** Lower case, no accents, trimmed, inner spaces collapsed: "  CÁMARA Térmica " → "camara termica". */
export function normalizeText(s: string): string {
  return s.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase().trim().replace(/\s+/g, " ")
}

export function templateValue(card: Pick<EquipmentCardDTO, "templateName">): string {
  return card.templateName ? `t:${card.templateName}` : "none"
}

export function filterCards<C extends EquipmentCardDTO>(cards: readonly C[], f: BancoFilters, viewerId: string): C[] {
  const q = normalizeText(f.query)
  return cards.filter((c) => {
    if (f.template !== null && templateValue(c) !== f.template) return false
    if (f.only === "mine" && c.reservation?.holderId !== viewerId) return false
    if (f.only === "free" && c.reservation !== null) return false
    if (q) {
      const hay = normalizeText(`${c.name} ${c.serialNumber ?? ""}`)
      if (!hay.includes(q)) return false
    }
    return true
  })
}

export interface TemplateOption { value: string; label: string; count: number }

/** Template chips from the data: templates by name, then "Sin plantilla" when some unit has none. */
export function templateOptions(cards: readonly EquipmentCardDTO[]): TemplateOption[] {
  const counts = new Map<string, number>()
  let none = 0
  for (const c of cards) {
    if (c.templateName) counts.set(c.templateName, (counts.get(c.templateName) ?? 0) + 1)
    else none++
  }
  const opts = [...counts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], "es", { numeric: true }))
    .map(([name, count]) => ({ value: `t:${name}`, label: name, count }))
  if (none) opts.push({ value: "none", label: banco.noTemplate, count: none })
  return opts
}

// ── Live deltas ────────────────────────────────────────────────────────────────────────────────────────────────

export const BANCO_EVENTS = ["reservation.changed", "console.status", "console.activity", "relay.state", "access.status"] as const

function mapCard<C extends EquipmentCardDTO>(cards: readonly C[], id: string, fn: (c: C) => C): C[] {
  let changed = false
  const next = cards.map((c) => {
    if (c.id !== id) return c
    const n = fn(c)
    if (n !== c) changed = true
    return n
  })
  return changed ? next : (cards as C[])
}

/** Applies one SSE event to the cards; returns the same array when nothing changed. */
export function reduceCards<C extends EquipmentCardDTO>(cards: readonly C[], e: ServerEvent): C[] {
  switch (e.type) {
    case "reservation.changed":
      return mapCard(cards, e.equipmentId, (c) => ({ ...c, reservation: e.reservation }))
    case "console.status":
      return mapCard(cards, e.equipmentId, (c) => {
        if (!c.consoles.some((k) => k.id === e.consoleId)) return c
        return { ...c, consoles: c.consoles.map((k) => (k.id === e.consoleId ? { ...k, runtime: e.runtime } : k)) }
      })
    case "access.status":
      return mapCard(cards, e.equipmentId, (c) => {
        if (!c.accesses.some((a) => a.id === e.accessId)) return c
        return { ...c, accesses: c.accesses.map((a) => (a.id === e.accessId ? { ...a, runtime: e.runtime } : a)) }
      })
    case "console.activity":
      return mapCard(cards, e.equipmentId, (c) => {
        if (!c.consoles.some((k) => k.id === e.consoleId)) return c
        return {
          ...c,
          consoles: c.consoles.map((k) => (k.id === e.consoleId ? { ...k, runtime: { ...k.runtime, lastLine: e.lastLine, lastRxAt: e.lastRxAt } } : k)),
        }
      })
    case "relay.state": {
      const byId = new Map(e.channels.map((ch) => [ch.channelId, ch]))
      return mapCard(cards, e.equipmentId, (c) => {
        if (!c.relays.some((r) => byId.has(r.id))) return c
        return {
          ...c,
          relays: c.relays.map((r) => {
            const s = byId.get(r.id)
            return s ? { ...r, on: s.on, stale: s.stale } : r
          }),
        }
      })
    }
    default:
      return cards as C[]
  }
}
