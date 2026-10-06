import { describe, expect, it } from "vitest"
import { AuditQuerySchema } from "@/lib/contracts/audit"
import {
  activeFilterCount, auditApiSearch, auditFiltersQuery, auditFiltersSearch, DEFAULT_AUDIT_FILTERS, hasActiveFilters, localDay, parseAuditFilters, parseDay,
} from "./audit-filters"

describe("parseAuditFilters", () => {
  it("defaults to the whole period with no filters", () => {
    expect(parseAuditFilters(new URLSearchParams(""))).toEqual(DEFAULT_AUDIT_FILTERS)
    expect(hasActiveFilters(DEFAULT_AUDIT_FILTERS)).toBe(false)
  })

  it("reads every Spanish parameter", () => {
    const f = parseAuditFilters({ categoria: "relay", usuario: "u1", equipo: "eq7", resultado: "denied", periodo: "30d" })
    expect(f).toEqual({ period: "30d", from: null, to: null, category: "relay", userId: "u1", equipmentId: "eq7", outcome: "denied" })
  })

  it("ignores invalid values", () => {
    const f = parseAuditFilters({ categoria: "nope", usuario: "../x", equipo: "a b", resultado: "maybe", periodo: "1y", desde: "2026-02-30" })
    expect(f).toEqual(DEFAULT_AUDIT_FILTERS)
  })

  it("a date makes the period custom and wins over periodo", () => {
    const f = parseAuditFilters({ periodo: "hoy", desde: "2026-09-01" })
    expect(f.period).toBe("custom")
    expect(f.from).toBe("2026-09-01")
    expect(f.to).toBeNull()
  })

  it("swaps a reversed range", () => {
    const f = parseAuditFilters({ desde: "2026-09-20", hasta: "2026-09-01" })
    expect([f.from, f.to]).toEqual(["2026-09-01", "2026-09-20"])
  })

  it("takes the first value of repeated parameters", () => {
    expect(parseAuditFilters({ categoria: ["board", "relay"] }).category).toBe("board")
  })
})

describe("activeFilterCount", () => {
  it("counts the filters that differ from the defaults", () => {
    expect(activeFilterCount(DEFAULT_AUDIT_FILTERS)).toBe(0)
    expect(activeFilterCount(parseAuditFilters({ periodo: "hoy", categoria: "board", resultado: "ok" }))).toBe(3)
    expect(activeFilterCount(parseAuditFilters({ desde: "2026-09-01", usuario: "u1", equipo: "e1" }))).toBe(3)
  })
})

describe("parseDay", () => {
  it("accepts real days only", () => {
    expect(parseDay("2026-02-28")).toBe("2026-02-28")
    expect(parseDay("2026-02-29")).toBeNull()
    expect(parseDay("2026-9-1")).toBeNull()
    expect(parseDay(null)).toBeNull()
  })
})

describe("auditFiltersSearch", () => {
  it("round-trips through the URL", () => {
    const cases = [
      "?periodo=hoy&categoria=board",
      "?desde=2026-09-01&hasta=2026-09-20&usuario=u1&equipo=e2&resultado=error",
      "?hasta=2026-09-20",
      "",
    ]
    for (const c of cases) expect(auditFiltersSearch(parseAuditFilters(new URLSearchParams(c)))).toBe(c)
  })

  it("omits the default period", () => {
    expect(auditFiltersSearch({ ...DEFAULT_AUDIT_FILTERS, period: "todo", outcome: "ok" })).toBe("?resultado=ok")
  })
})

describe("auditFiltersQuery", () => {
  const now = new Date(2026, 8, 23, 15, 42, 10) // 23 Sep 2026, local time

  it("presets start at local midnight", () => {
    expect(auditFiltersQuery({ ...DEFAULT_AUDIT_FILTERS, period: "hoy" }, now).from).toBe(new Date(2026, 8, 23).toISOString())
    expect(auditFiltersQuery({ ...DEFAULT_AUDIT_FILTERS, period: "7d" }, now).from).toBe(new Date(2026, 8, 17).toISOString())
    expect(auditFiltersQuery({ ...DEFAULT_AUDIT_FILTERS, period: "30d" }, now).from).toBe(new Date(2026, 7, 25).toISOString())
    const all = auditFiltersQuery(DEFAULT_AUDIT_FILTERS, now)
    expect(all.from).toBeUndefined()
    expect(all.to).toBeUndefined()
  })

  it("a custom range includes the whole last day", () => {
    const q = auditFiltersQuery({ ...DEFAULT_AUDIT_FILTERS, period: "custom", from: "2026-09-01", to: "2026-09-20" }, now)
    expect(q.from).toBe(new Date(2026, 8, 1).toISOString())
    expect(q.to).toBe(new Date(2026, 8, 20, 23, 59, 59, 999).toISOString())
  })

  it("maps the other filters and validates against the route schema", () => {
    const f = parseAuditFilters({ categoria: "console", usuario: "u1", equipo: "eq1", resultado: "error", periodo: "7d" })
    const q = auditFiltersQuery(f, now)
    expect(q).toMatchObject({ category: "console", actorId: "u1", equipmentId: "eq1", outcome: "error", limit: 50 })
    const parsed = AuditQuerySchema.safeParse(Object.fromEntries(new URLSearchParams(auditApiSearch(q, "120"))))
    expect(parsed.success).toBe(true)
    expect(parsed.data).toMatchObject({ category: "console", actorId: "u1", cursor: 120, limit: 50, from: q.from })
  })
})

describe("auditApiSearch", () => {
  it("adds the cursor only when there is one", () => {
    expect(auditApiSearch({ limit: 50 })).toBe("?limit=50")
    expect(auditApiSearch({ limit: 50, outcome: "ok" }, "77")).toBe("?outcome=ok&limit=50&cursor=77")
  })
})

describe("localDay", () => {
  it("formats a local date", () => {
    expect(localDay(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05")
  })
})
