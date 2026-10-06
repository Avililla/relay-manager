import { describe, expect, it } from "vitest"
import type { EquipmentCardDTO, ConsoleSummaryDTO, RelayChannelSummaryDTO } from "@/lib/contracts/equipment"
import type { ConsoleRuntimeDTO } from "@/lib/contracts/serial"
import type { ReservationDTO } from "@/lib/contracts/reservations"
import {
  bancoCounts, defaultFilters, filterCards, hasActiveFilters, normalizeText, reduceCards, templateOptions, unitSummary,
} from "./banco-model"

const NOW = Date.parse("2026-09-23T10:00:00.000Z")
const iso = (ms: number) => new Date(ms).toISOString()

function runtime(p: Partial<ConsoleRuntimeDTO> = {}): ConsoleRuntimeDTO {
  return { status: "open", devNode: "/dev/ttyUSB0", detail: null, since: iso(NOW - 60_000), lastRxAt: null, lastLine: null, viewers: 0, released: null, capture: "active", ...p }
}
function con(id: string, p: Partial<ConsoleRuntimeDTO> = {}): ConsoleSummaryDTO {
  return {
    id, key: id.toUpperCase(), label: id, position: 0, line: { baudRate: 115200, dataBits: 8, parity: "none", stopBits: 1, flowControl: "none" },
    enterMode: "cr", localEcho: false, matchBy: "adapter", adapterLabel: null, adapterShort: "FT4ABCDE·A", runtime: runtime(p),
  }
}
function relay(id: string, p: Partial<RelayChannelSummaryDTO> = {}): RelayChannelSummaryDTO {
  return {
    id, key: id.toUpperCase(), label: id, purpose: "power", position: 0, requireConfirm: false, defaultPulseMs: null,
    boardId: "b1", boardName: "dS378", channel: 1, on: false, stale: false, boardOnline: true, pulse: "native", pulseMs: { min: 19, max: 60000, step: 1 }, ...p,
  }
}
function res(holderId: string, p: Partial<ReservationDTO> = {}): ReservationDTO {
  return { equipmentId: "e", holderId, holderName: holderId === "me" ? "Ana Ruiz" : "Jorge Duro", holderUsername: holderId, reservedAt: iso(NOW - 60_000), expiresAt: iso(NOW + 30 * 60_000), note: null, ...p }
}
function card(id: string, p: Partial<EquipmentCardDTO> = {}): EquipmentCardDTO {
  return {
    id, name: `Equipo A #${id}`, serialNumber: `EA-${id}`, description: null, templateId: "t1", templateName: "Equipo A", position: 0,
    roles: [], consoles: [con(`${id}c1`)], relays: [], reservation: null, accesses: [], ...p,
  }
}

describe("unitSummary (precedence danger > other > mine > active > idle)", () => {
  it("idle when nothing happens", () => {
    expect(unitSummary(card("01"), "me", NOW)).toBe("idle")
  })
  it("active when a console received data in the last 5 s", () => {
    expect(unitSummary(card("01", { consoles: [con("a", { lastRxAt: iso(NOW - 2000) })] }), "me", NOW)).toBe("active")
    expect(unitSummary(card("01", { consoles: [con("a", { lastRxAt: iso(NOW - 6000) })] }), "me", NOW)).toBe("idle")
  })
  it("mine beats active; other beats mine", () => {
    const active = [con("a", { lastRxAt: iso(NOW - 1000) })]
    expect(unitSummary(card("01", { consoles: active, reservation: res("me") }), "me", NOW)).toBe("mine")
    expect(unitSummary(card("01", { consoles: active, reservation: res("jd") }), "me", NOW)).toBe("other")
  })
  it("danger beats everything: missing adapter, no permission, error, board offline", () => {
    for (const status of ["missing", "no-permission", "error"] as const) {
      expect(unitSummary(card("01", { consoles: [con("a", { status })], reservation: res("jd") }), "me", NOW)).toBe("danger")
    }
    expect(unitSummary(card("01", { relays: [relay("r", { boardOnline: false })], reservation: res("me") }), "me", NOW)).toBe("danger")
  })
  it("busy, released and unbound are not danger", () => {
    for (const status of ["busy", "released", "unbound", "opening"] as const) {
      expect(unitSummary(card("01", { consoles: [con("a", { status })] }), "me", NOW)).toBe("idle")
    }
  })
  it("a board never polled (null) is not danger", () => {
    expect(unitSummary(card("01", { relays: [relay("r", { boardOnline: null })] }), "me", NOW)).toBe("idle")
  })
})

describe("bancoCounts", () => {
  it("counts total, reserved and incidents", () => {
    const cards = [
      card("01", { reservation: res("me") }),
      card("02", { reservation: res("jd"), consoles: [con("x", { status: "missing" })] }),
      card("03"),
    ]
    expect(bancoCounts(cards)).toEqual({ total: 3, reserved: 2, incidents: 1 })
  })
})

describe("filters", () => {
  const cards = [
    card("01", { name: "Equipo A #01", serialNumber: "EA-0001", reservation: res("me") }),
    card("02", { name: "Equipo A #02", serialNumber: "EA-0002", reservation: res("jd") }),
    card("03", { name: "Cámara térmica", serialNumber: null, templateId: null, templateName: null }),
    card("04", { name: "Equipo C #01", serialNumber: "CN-77", templateId: "t3", templateName: "Equipo C" }),
  ]
  it("normalizes accents and case", () => {
    expect(normalizeText("  CÁMARA Térmica ")).toBe("camara termica")
  })
  it("defaults show everything", () => {
    expect(filterCards(cards, defaultFilters(), "me").map((c) => c.id)).toEqual(["01", "02", "03", "04"])
    expect(hasActiveFilters(defaultFilters())).toBe(false)
  })
  it("searches the name and the serial number, accent-insensitive", () => {
    expect(filterCards(cards, { ...defaultFilters(), query: "camara" }, "me").map((c) => c.id)).toEqual(["03"])
    expect(filterCards(cards, { ...defaultFilters(), query: "cn-77" }, "me").map((c) => c.id)).toEqual(["04"])
    expect(filterCards(cards, { ...defaultFilters(), query: "ea-000" }, "me").map((c) => c.id)).toEqual(["01", "02"])
  })
  it("filters by template, including units without one", () => {
    expect(filterCards(cards, { ...defaultFilters(), template: "t:Equipo A" }, "me").map((c) => c.id)).toEqual(["01", "02"])
    expect(filterCards(cards, { ...defaultFilters(), template: "none" }, "me").map((c) => c.id)).toEqual(["03"])
  })
  it("only mine / only free", () => {
    expect(filterCards(cards, { ...defaultFilters(), only: "mine" }, "me").map((c) => c.id)).toEqual(["01"])
    expect(filterCards(cards, { ...defaultFilters(), only: "free" }, "me").map((c) => c.id)).toEqual(["03", "04"])
  })
  it("template options come from the data, with counts, templates first then 'Sin plantilla'", () => {
    expect(templateOptions(cards)).toEqual([
      { value: "t:Equipo A", label: "Equipo A", count: 2 },
      { value: "t:Equipo C", label: "Equipo C", count: 1 },
      { value: "none", label: "Sin plantilla", count: 1 },
    ])
  })
})

describe("reduceCards (live SSE deltas)", () => {
  const cards = [card("01", { consoles: [con("c1"), con("c2")], relays: [relay("r1"), relay("r2")] }), card("02")]
  it("keeps identity for events of other equipment", () => {
    expect(reduceCards(cards, { type: "reservation.changed", equipmentId: "zz", equipmentName: "x", reservation: null, cause: "release", byName: null, serverNow: iso(NOW) })).toBe(cards)
  })
  it("applies reservation.changed", () => {
    const r = res("jd", { equipmentId: "01" })
    const next = reduceCards(cards, { type: "reservation.changed", equipmentId: "01", equipmentName: "x", reservation: r, cause: "reserve", byName: "Jorge Duro", serverNow: iso(NOW) })
    expect(next[0].reservation).toEqual(r)
    expect(next[1]).toBe(cards[1])
  })
  it("applies console.status and console.activity", () => {
    const rt = runtime({ status: "missing" })
    const a = reduceCards(cards, { type: "console.status", equipmentId: "01", consoleId: "c2", runtime: rt })
    expect(a[0].consoles[1].runtime).toEqual(rt)
    expect(a[0].consoles[0]).toBe(cards[0].consoles[0])
    const b = reduceCards(a, { type: "console.activity", equipmentId: "01", consoleId: "c1", lastLine: "login:", lastRxAt: iso(NOW) })
    expect(b[0].consoles[0].runtime.lastLine).toBe("login:")
    expect(b[0].consoles[0].runtime.lastRxAt).toBe(iso(NOW))
    expect(b[0].consoles[1]).toBe(a[0].consoles[1])
  })
  it("applies relay.state", () => {
    const next = reduceCards(cards, { type: "relay.state", equipmentId: "01", channels: [{ channelId: "r2", on: true, stale: false }], at: iso(NOW) })
    expect(next[0].relays[1].on).toBe(true)
    expect(next[0].relays[0]).toBe(cards[0].relays[0])
  })
  it("ignores unknown consoles and channels without changing identity", () => {
    expect(reduceCards(cards, { type: "console.status", equipmentId: "01", consoleId: "nope", runtime: runtime() })).toBe(cards)
    expect(reduceCards(cards, { type: "relay.state", equipmentId: "01", channels: [{ channelId: "nope", on: true, stale: false }], at: iso(NOW) })).toBe(cards)
  })
})
