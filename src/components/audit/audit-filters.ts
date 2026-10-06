// Auditoría filters (§8.9): the page URL (`?categoria=&usuario=&equipo=&resultado=&desde=&hasta=&periodo=`) is the
// single source of truth. Pure: parses the URL, rebuilds it, and turns it into the AuditQuery of /api/audit.
import { AUDIT_CATEGORIES, type AuditCategory, type AuditOutcome, type AuditQuery } from "@/lib/contracts/audit"
import { IdSchema } from "@/lib/contracts/common"

export const AUDIT_PAGE_SIZE = 50
export const AUDIT_PERIODS = ["hoy", "7d", "30d", "todo", "custom"] as const
export type AuditPeriod = (typeof AUDIT_PERIODS)[number]
const OUTCOMES = ["ok", "denied", "error"] as const

export interface AuditFilters {
  period: AuditPeriod
  /** "YYYY-MM-DD" (local day), only with period "custom". */
  from: string | null
  to: string | null
  category: AuditCategory | null
  userId: string | null
  equipmentId: string | null
  outcome: AuditOutcome | null
}

export const DEFAULT_AUDIT_FILTERS: AuditFilters = {
  period: "todo", from: null, to: null, category: null, userId: null, equipmentId: null, outcome: null,
}

type Params = URLSearchParams | Record<string, string | string[] | undefined>

function param(p: Params, key: string): string | null {
  const v = p instanceof URLSearchParams ? p.get(key) : p[key]
  const s = Array.isArray(v) ? v[0] : v
  return typeof s === "string" && s.trim() ? s.trim() : null
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/

/** A real calendar day "YYYY-MM-DD", or null. */
export function parseDay(v: string | null): string | null {
  const m = v ? DAY.exec(v) : null
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const dt = new Date(y, mo - 1, d)
  return dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d ? (v as string) : null
}

const oneOf = <T extends string>(list: readonly T[], v: string | null): T | null => (v !== null && (list as readonly string[]).includes(v) ? (v as T) : null)
const id = (v: string | null): string | null => (v !== null && IdSchema.safeParse(v).success ? v : null)

/** Reads the page URL. Invalid values are ignored; a reversed custom range is swapped. */
export function parseAuditFilters(p: Params): AuditFilters {
  let from = parseDay(param(p, "desde"))
  let to = parseDay(param(p, "hasta"))
  if (from && to && from > to) [from, to] = [to, from]
  const preset = oneOf(["hoy", "7d", "30d", "todo"] as const, param(p, "periodo"))
  const period: AuditPeriod = from || to ? "custom" : (preset ?? DEFAULT_AUDIT_FILTERS.period)
  return {
    period,
    from: period === "custom" ? from : null,
    to: period === "custom" ? to : null,
    category: oneOf(AUDIT_CATEGORIES, param(p, "categoria")),
    userId: id(param(p, "usuario")),
    equipmentId: id(param(p, "equipo")),
    outcome: oneOf(OUTCOMES, param(p, "resultado")),
  }
}

/** The canonical page query string ("" for the defaults), in a stable order. */
export function auditFiltersSearch(f: AuditFilters): string {
  const s = new URLSearchParams()
  if (f.period === "custom") {
    if (f.from) s.set("desde", f.from)
    if (f.to) s.set("hasta", f.to)
  } else if (f.period !== DEFAULT_AUDIT_FILTERS.period) {
    s.set("periodo", f.period)
  }
  if (f.category) s.set("categoria", f.category)
  if (f.userId) s.set("usuario", f.userId)
  if (f.equipmentId) s.set("equipo", f.equipmentId)
  if (f.outcome) s.set("resultado", f.outcome)
  const q = s.toString()
  return q ? `?${q}` : ""
}

/** How many filters differ from the defaults (the mobile "Filtros (N)" toggle). */
export function activeFilterCount(f: AuditFilters): number {
  return [f.period !== DEFAULT_AUDIT_FILTERS.period, f.category, f.userId, f.equipmentId, f.outcome].filter(Boolean).length
}

export function hasActiveFilters(f: AuditFilters): boolean {
  return auditFiltersSearch(f) !== ""
}

/** Start of a local day, `days` days after `day` (negative = before). */
function localDayStart(day: Date, days = 0): Date {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() + days)
}
function dayDate(v: string): Date {
  const [y, m, d] = v.split("-").map(Number)
  return new Date(y, m - 1, d)
}

/**
 * The AuditQuery for the filters. Days are local to the process that calls it (the server renders the page, so
 * they follow the server's time zone, which is the bench host's). `hasta` includes the whole day.
 */
export function auditFiltersQuery(f: AuditFilters, now: Date, limit = AUDIT_PAGE_SIZE): AuditQuery {
  const q: AuditQuery = { limit }
  if (f.period === "hoy") q.from = localDayStart(now).toISOString()
  else if (f.period === "7d") q.from = localDayStart(now, -6).toISOString()
  else if (f.period === "30d") q.from = localDayStart(now, -29).toISOString()
  else if (f.period === "custom") {
    if (f.from) q.from = dayDate(f.from).toISOString()
    if (f.to) q.to = new Date(localDayStart(dayDate(f.to), 1).getTime() - 1).toISOString()
  }
  if (f.category) q.category = f.category
  if (f.userId) q.actorId = f.userId
  if (f.equipmentId) q.equipmentId = f.equipmentId
  if (f.outcome) q.outcome = f.outcome
  return q
}

/** Query string for `/api/audit` ("Cargar más") and `/api/audit/export` (the route ignores `limit` there). */
export function auditApiSearch(q: AuditQuery, cursor?: string | null): string {
  const s = new URLSearchParams()
  if (q.from) s.set("from", q.from)
  if (q.to) s.set("to", q.to)
  if (q.actorId) s.set("actorId", q.actorId)
  if (q.equipmentId) s.set("equipmentId", q.equipmentId)
  if (q.category) s.set("category", q.category)
  if (q.action) s.set("action", q.action)
  if (q.outcome) s.set("outcome", q.outcome)
  s.set("limit", String(q.limit))
  if (cursor) s.set("cursor", cursor)
  return `?${s.toString()}`
}

/** "YYYY-MM-DD" of a local date (for the DateRangeField defaults). */
export function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}
