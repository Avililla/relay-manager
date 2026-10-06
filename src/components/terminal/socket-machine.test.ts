import { describe, expect, it } from "vitest"
import { WS_CLOSE } from "@/lib/contracts/ws"
import {
  BACKOFF_MS, CONNECTED_RESET_MS, backoffMs, closeAction, initialSocketState, socketReducer, type SocketState,
} from "./socket-machine"

const run = (s: SocketState, ...events: Parameters<typeof socketReducer>[1][]): SocketState => events.reduce(socketReducer, s)

describe("socket-machine", () => {
  it("goes idle → connecting → open(ro) → open(rw)", () => {
    let s = initialSocketState()
    expect(s.kind).toBe("idle")
    s = socketReducer(s, { type: "connect" })
    expect(s).toMatchObject({ kind: "connecting", attempt: 0 })
    s = socketReducer(s, { type: "hello", mode: "ro", at: 1000 })
    expect(s).toMatchObject({ kind: "open", mode: "ro", historyDone: false, openedAt: 1000 })
    s = socketReducer(s, { type: "history-end" })
    expect(s).toMatchObject({ kind: "open", historyDone: true })
    s = socketReducer(s, { type: "mode", mode: "rw" })
    expect(s).toMatchObject({ kind: "open", mode: "rw", historyDone: true })
  })

  it("ignores mode and history-end outside open", () => {
    const s = run(initialSocketState(), { type: "connect" })
    expect(socketReducer(s, { type: "mode", mode: "rw" })).toBe(s)
    expect(socketReducer(s, { type: "history-end" })).toBe(s)
  })

  it("4009 (too many sessions) never reconnects automatically", () => {
    const s = run(initialSocketState(), { type: "connect" }, { type: "hello", mode: "ro", at: 0 },
      { type: "close", code: WS_CLOSE.TOO_MANY_SESSIONS, reason: "Demasiadas sesiones", at: 100 })
    expect(s).toMatchObject({ kind: "closed", code: 4009, action: "too-many", retryInMs: null })
    // Only a manual retry reconnects, and it starts over at attempt 0.
    const r = socketReducer(s, { type: "manual-retry" })
    expect(r).toMatchObject({ kind: "connecting", attempt: 0 })
    // A stray timer "retry" is ignored when no retry was planned.
    expect(socketReducer(s, { type: "retry" })).toBe(s)
  })

  it("maps every close code to its client behaviour (§5.4)", () => {
    expect(closeAction(WS_CLOSE.NORMAL)).toBe("none")
    expect(closeAction(WS_CLOSE.GOING_AWAY)).toBe("reconnect")
    expect(closeAction(WS_CLOSE.INTERNAL)).toBe("reconnect")
    expect(closeAction(1006)).toBe("reconnect")
    expect(closeAction(WS_CLOSE.UNAUTHENTICATED)).toBe("login")
    expect(closeAction(WS_CLOSE.PROTOCOL)).toBe("protocol-error")
    expect(closeAction(WS_CLOSE.PASSWORD_CHANGE)).toBe("change-password")
    expect(closeAction(WS_CLOSE.NOT_FOUND)).toBe("not-found")
    expect(closeAction(WS_CLOSE.SLOW_CONSUMER)).toBe("reconnect-now")
    expect(closeAction(WS_CLOSE.TOO_MANY_SESSIONS)).toBe("too-many")
    expect(closeAction(WS_CLOSE.SESSION_REVOKED)).toBe("revoked")
    expect(closeAction(WS_CLOSE.CONSOLE_CHANGED)).toBe("refresh")
  })

  it("no automatic retry for 1000, 4001, 4002, 4003, 4004, 4010, 4011", () => {
    for (const code of [1000, 4001, 4002, 4003, 4004, 4010, 4011]) {
      const s = run(initialSocketState(), { type: "connect" }, { type: "close", code, reason: "", at: 10 })
      expect(s.kind === "closed" && s.retryInMs, String(code)).toBe(null)
    }
  })

  it("backs off 0.5 s, 1 s, 2 s, 5 s, 10 s and stays at 10 s", () => {
    expect(BACKOFF_MS).toEqual([500, 1000, 2000, 5000, 10000])
    expect([0, 1, 2, 3, 4, 5, 9].map(backoffMs)).toEqual([500, 1000, 2000, 5000, 10000, 10000, 10000])
    let s = run(initialSocketState(), { type: "connect" })
    const delays: Array<number | null> = []
    for (let i = 0; i < 6; i++) {
      s = socketReducer(s, { type: "close", code: 1006, reason: "", at: i * 10 })
      delays.push(s.kind === "closed" ? s.retryInMs : -1)
      s = socketReducer(s, { type: "retry" })
      expect(s.kind).toBe("connecting")
    }
    expect(delays).toEqual([500, 1000, 2000, 5000, 10000, 10000])
    expect(s).toMatchObject({ kind: "connecting", attempt: 6 })
  })

  it("resets the backoff after 30 s connected", () => {
    let s = run(initialSocketState(), { type: "connect" },
      { type: "close", code: 1006, reason: "", at: 0 }, { type: "retry" },
      { type: "close", code: 1006, reason: "", at: 1 }, { type: "retry" })
    expect(s).toMatchObject({ kind: "connecting", attempt: 2 })
    // Open briefly: the attempt count is kept.
    s = run(s, { type: "hello", mode: "ro", at: 10_000 }, { type: "close", code: 1001, reason: "", at: 10_000 + CONNECTED_RESET_MS - 1 })
    expect(s).toMatchObject({ kind: "closed", attempt: 2, retryInMs: 2000 })
    // Open for 30 s or more: back to the first delay.
    s = run(s, { type: "retry" }, { type: "hello", mode: "rw", at: 100_000 }, { type: "close", code: 1001, reason: "", at: 100_000 + CONNECTED_RESET_MS })
    expect(s).toMatchObject({ kind: "closed", attempt: 0, retryInMs: 500 })
  })

  it("4008 (slow consumer) reconnects immediately", () => {
    const s = run(initialSocketState(), { type: "connect" }, { type: "hello", mode: "ro", at: 0 },
      { type: "close", code: WS_CLOSE.SLOW_CONSUMER, reason: "", at: 5 })
    expect(s).toMatchObject({ kind: "closed", action: "reconnect-now", retryInMs: 0 })
  })

  it("dispose returns to idle from any state", () => {
    const s = run(initialSocketState(), { type: "connect" }, { type: "hello", mode: "rw", at: 0 }, { type: "dispose" })
    expect(s.kind).toBe("idle")
  })
})
