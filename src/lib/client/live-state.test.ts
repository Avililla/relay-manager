import { describe, expect, it } from "vitest"
import type { ServerEvent } from "@/lib/contracts/events"
import { applyLiveEvent, initLiveCell, syncLiveCell } from "./live-state"

interface Card { id: string; lastLine: string | null }
const activity = (lastLine: string): ServerEvent => ({ type: "console.activity", equipmentId: "e1", consoleId: "c1", lastLine, lastRxAt: "2026-09-23T10:00:00.000Z" })
const reduce = (s: Card, e: ServerEvent): Card => (e.type === "console.activity" ? { ...s, lastLine: e.lastLine } : s)

describe("live state", () => {
  it("applies only the matching event types", () => {
    const server: Card = { id: "e1", lastLine: null }
    let cell = initLiveCell(server)
    cell = applyLiveEvent(cell, activity("login:"), ["console.activity"], reduce)
    expect(cell.value.lastLine).toBe("login:")
    const same = applyLiveEvent(cell, { type: "heartbeat", serverNow: "2026-09-23T10:00:00.000Z" }, ["console.activity"], reduce)
    expect(same).toBe(cell)
  })

  it("keeps applied events while the server value keeps its identity", () => {
    const server: Card = { id: "e1", lastLine: null }
    let cell = applyLiveEvent(initLiveCell(server), activity("U-Boot"), ["console.activity"], reduce)
    cell = syncLiveCell(cell, server)
    expect(cell.value.lastLine).toBe("U-Boot")
  })

  it("resets to a new server value (new RSC payload after router.refresh())", () => {
    const first: Card = { id: "e1", lastLine: null }
    let cell = applyLiveEvent(initLiveCell(first), activity("stale"), ["console.activity"], reduce)
    const refreshed: Card = { id: "e1", lastLine: null }   // deep-equal, new identity
    cell = syncLiveCell(cell, refreshed)
    expect(cell.base).toBe(refreshed)
    expect(cell.value).toBe(refreshed)
    expect(cell.value.lastLine).toBeNull()
  })

  it("returns the same cell object when nothing changes (no extra render)", () => {
    const server: Card = { id: "e1", lastLine: null }
    const cell = initLiveCell(server)
    expect(syncLiveCell(cell, server)).toBe(cell)
  })

  it("a reducer that returns the same state keeps the cell", () => {
    const cell = initLiveCell<Card>({ id: "e1", lastLine: null })
    expect(applyLiveEvent(cell, activity("x"), ["console.activity"], (s) => s)).toBe(cell)
  })
})
