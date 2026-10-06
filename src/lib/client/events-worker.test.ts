import { readFileSync } from "node:fs"
import path from "node:path"
import vm from "node:vm"
import { describe, expect, it } from "vitest"
import type { ServerEvent } from "@/lib/contracts/events"
import { addClockSample, clockOffset } from "./countdown"
import { clockSampleOf, parseWorkerMsg } from "./events-runtime"

// Runs the real public/events-worker.js (plain JS, not bundled) in a VM context with a fake EventSource and fake
// MessagePorts, then feeds what a tab receives through the same pure pieces EventsProvider uses.
const WORKER_JS = readFileSync(path.resolve(__dirname, "../../../public/events-worker.js"), "utf8")

class FakeEventSource {
  readyState = 0
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  constructor(readonly url: string) {}
  close() {
    this.readyState = 2
  }
}

interface FakePort {
  received: unknown[]
  onmessage: ((m: { data: unknown }) => void) | null
  send(cmd: string): void
}

function loadWorker() {
  const sources: FakeEventSource[] = []
  const self: { onconnect?: (e: { ports: unknown[] }) => void } = {}
  vm.runInNewContext(WORKER_JS, {
    self,
    EventSource: class extends FakeEventSource {
      constructor(url: string) {
        super(url)
        sources.push(this)
      }
    },
    setTimeout: () => 0,
    clearTimeout: () => undefined,
  })
  const connect = (): FakePort => {
    const port: FakePort = {
      received: [],
      onmessage: null,
      send(cmd) {
        this.onmessage?.({ data: { cmd } })
      },
    }
    const wire = {
      set onmessage(fn: FakePort["onmessage"]) {
        port.onmessage = fn
      },
      start() {},
      // Structured clone: the tab gets a plain copy, never the worker realm's object.
      postMessage(msg: unknown) {
        port.received.push(JSON.parse(JSON.stringify(msg)))
      },
    }
    self.onconnect?.({ ports: [wire] })
    return port
  }
  const live = () => sources[sources.length - 1]
  const emit = (e: ServerEvent) => live().onmessage?.({ data: JSON.stringify(e) })
  return { connect, sources, live, emit }
}

const T0 = Date.parse("2026-09-23T08:00:00.000Z")
const iso = (ms: number) => new Date(ms).toISOString()
const hello = (ms: number): ServerEvent => ({ type: "hello", serverNow: iso(ms), buildId: "b1", version: "2.0.0", viewerId: "u1" })
const events = (p: FakePort) => p.received.map(parseWorkerMsg).filter((m) => m?.kind === "event")

describe("events worker: cached hello replay (§8.11)", () => {
  it("the first tab gets the live hello; a tab joining later gets the cached one marked replay", () => {
    const w = loadWorker()
    const a = w.connect()
    expect(w.sources).toHaveLength(1)
    w.live().onopen?.()
    w.emit(hello(T0))
    expect(events(a)).toEqual([{ kind: "event", data: JSON.stringify(hello(T0)), replay: false }])

    w.emit({ type: "heartbeat", serverNow: iso(T0 + 60_000) })
    const b = w.connect()
    expect(w.sources).toHaveLength(1) // one stream per browser
    expect(parseWorkerMsg(b.received[0])).toEqual({ kind: "status", status: "open" })
    expect(events(b)).toEqual([{ kind: "event", data: JSON.stringify(hello(T0)), replay: true }])
  })

  it("a back/forward-cache rejoin (bye, then hello) gets the cached hello marked replay again", () => {
    const w = loadWorker()
    const a = w.connect()
    w.live().onopen?.()
    w.emit(hello(T0))
    const b = w.connect()
    b.send("bye")
    b.received.length = 0
    b.send("hello")
    expect(events(b)).toEqual([{ kind: "event", data: JSON.stringify(hello(T0)), replay: true }])
    // "hello" from an attached port is a no-op: no second replay.
    a.received.length = 0
    a.send("hello")
    expect(a.received).toEqual([])
  })

  it("a new hello after a reconnect goes to every tab as live", () => {
    const w = loadWorker()
    const a = w.connect()
    w.live().onopen?.()
    w.emit(hello(T0))
    const b = w.connect()
    a.received.length = 0
    b.received.length = 0
    a.send("reconnect")
    expect(w.sources).toHaveLength(2)
    w.live().onopen?.()
    w.emit(hello(T0 + 3_600_000))
    for (const p of [a, b]) expect(events(p)).toEqual([{ kind: "event", data: JSON.stringify(hello(T0 + 3_600_000)), replay: false }])
  })

  it("a tab joining an 8 h old stream keeps the seeded server clock (no offset from the stale hello)", () => {
    const w = loadWorker()
    w.connect()
    w.live().onopen?.()
    w.emit(hello(T0))
    const joinAt = T0 + 8 * 3_600_000 // client and server clocks agree: the true offset is 0
    const b = w.connect()
    // Tab B's ServerClockProvider seed (ShellDTO.serverNow of its own render), then what EventsProvider samples.
    let samples = addClockSample([], iso(joinAt), joinAt)
    for (const m of b.received.map(parseWorkerMsg)) {
      if (m?.kind !== "event") continue
      const s = clockSampleOf(JSON.parse(m.data) as ServerEvent, m.replay)
      if (s) samples = addClockSample(samples, s, joinAt)
    }
    expect(clockOffset(samples)).toBe(0)
    // Without the replay flag the stale hello would pull the median to half the stream's age (-4 h).
    const naive = addClockSample(addClockSample([], iso(joinAt), joinAt), iso(T0), joinAt)
    expect(clockOffset(naive)).toBe(-4 * 3_600_000)
  })
})
