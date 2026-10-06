import { describe, expect, it } from "vitest"
import type { ConsoleRuntimeDTO } from "@/lib/contracts/serial"
import type { ViewerPresenceDTO } from "@/lib/contracts/ws"
import { distinctViewers, mergeRuntime, reduceConsoleList, viewersSummary } from "./runtime-merge"

const rt = (p: Partial<ConsoleRuntimeDTO>): ConsoleRuntimeDTO => ({
  status: "open", devNode: "/dev/ttyUSB0", detail: null, since: "2026-09-23T10:00:00.000Z", lastRxAt: null, lastLine: null,
  viewers: 0, released: null, capture: "active", ...p,
})

describe("mergeRuntime (SSE + console socket)", () => {
  it("uses whichever status is newer, and the latest activity from either", () => {
    const sse = rt({ status: "open", since: "2026-09-23T10:00:00.000Z", lastRxAt: "2026-09-23T10:05:00.000Z", lastLine: "login:" })
    const sock = rt({ status: "released", since: "2026-09-23T10:04:00.000Z", lastRxAt: "2026-09-23T10:01:00.000Z", lastLine: "old" })
    const m = mergeRuntime(sse, sock)
    expect(m.status).toBe("released")
    expect(m.lastRxAt).toBe("2026-09-23T10:05:00.000Z")
    expect(m.lastLine).toBe("login:")
  })
  it("keeps the SSE value without a socket", () => {
    const sse = rt({})
    expect(mergeRuntime(sse, null)).toBe(sse)
  })
  it("equal timestamps prefer the socket status", () => {
    const sse = rt({ status: "opening" })
    const sock = rt({ status: "open" })
    expect(mergeRuntime(sse, sock).status).toBe("open")
  })
})

describe("reduceConsoleList", () => {
  const list = [{ id: "c1", runtime: rt({}) }, { id: "c2", runtime: rt({}) }]
  it("applies status and activity for this equipment only", () => {
    const a = reduceConsoleList(list, { type: "console.status", equipmentId: "e1", consoleId: "c2", runtime: rt({ status: "missing" }) }, "e1")
    expect(a[1].runtime.status).toBe("missing")
    expect(a[0]).toBe(list[0])
    const b = reduceConsoleList(a, { type: "console.activity", equipmentId: "e1", consoleId: "c1", lastLine: "login:", lastRxAt: "2026-09-23T10:09:00.000Z" }, "e1")
    expect(b[0].runtime).toMatchObject({ lastLine: "login:", lastRxAt: "2026-09-23T10:09:00.000Z", status: "open" })
    expect(reduceConsoleList(list, { type: "console.status", equipmentId: "zz", consoleId: "c1", runtime: rt({}) }, "e1")).toBe(list)
    expect(reduceConsoleList(list, { type: "console.status", equipmentId: "e1", consoleId: "nope", runtime: rt({}) }, "e1")).toBe(list)
  })
})

describe("viewers", () => {
  const v = (userId: string, name: string, mode: "ro" | "rw" = "ro"): ViewerPresenceDTO => ({ userId, name, mode })
  it("counts people, not sessions; a writer wins", () => {
    expect(distinctViewers([v("a", "Ana"), v("a", "Ana", "rw"), v("b", "Bea")])).toEqual([v("a", "Ana", "rw"), v("b", "Bea")])
  })
  it("summary per console, skipping empty ones", () => {
    expect(viewersSummary([
      { key: "UART0", viewers: [v("a", "Ana", "rw")] },
      { key: "UART1", viewers: [v("a", "Ana"), v("b", "Bea")] },
      { key: "MBOX", viewers: [] },
    ])).toEqual([
      { key: "UART0", count: 1, names: ["Ana (escritura)"] },
      { key: "UART1", count: 2, names: ["Ana", "Bea"] },
    ])
  })
})
