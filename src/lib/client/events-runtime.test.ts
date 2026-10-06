import { describe, expect, it } from "vitest"
import type { ServerEvent } from "@/lib/contracts/events"
import {
  SERVER_TOAST_WARN_MS, VIEWER_RELOAD_GUARD_MS, clockSampleOf, createHelloGuard, parseWorkerMsg, serverToastView, viewerReloadAllowed,
} from "./events-runtime"

describe("hello viewer guard (§8.11)", () => {
  it("accepts the page's own viewer", () => {
    const g = createHelloGuard("u1")
    expect(g("u1")).toBe("accept")
    expect(g("u1")).toBe("accept")
  })

  it("reconnects once on a foreign viewer, then reloads instead of reconnecting again", () => {
    const g = createHelloGuard("u1")
    expect(g("u2")).toBe("reconnect")
    expect(g("u2")).toBe("reload")
    // A stream that keeps naming someone else never triggers another reconnect (the old endless loop).
    for (let i = 0; i < 50; i++) expect(g("u2")).toBe("ignore")
  })

  it("a stale foreign hello followed by ours is a single reconnect (sign-in in another tab, cached hello)", () => {
    const g = createHelloGuard("u1")
    expect(g("u2")).toBe("reconnect")
    expect(g("u1")).toBe("accept")
    // A later, separate mismatch gets its own single reconnect.
    expect(g("u3")).toBe("reconnect")
    expect(g("u1")).toBe("accept")
  })

  it("our hello after giving up re-arms the guard", () => {
    const g = createHelloGuard("u1")
    g("u2")
    expect(g("u2")).toBe("reload")
    expect(g("u1")).toBe("accept")
    expect(g("u2")).toBe("reconnect")
  })
})

describe("viewer reload guard", () => {
  const now = 1_000_000_000
  it("allows the first reload", () => {
    expect(viewerReloadAllowed(Number.NaN, now)).toBe(true)
    expect(viewerReloadAllowed(0, now)).toBe(true)
  })
  it("skips a reload right after the previous one", () => {
    expect(viewerReloadAllowed(now - 2000, now)).toBe(false)
    expect(viewerReloadAllowed(now - VIEWER_RELOAD_GUARD_MS + 1, now)).toBe(false)
  })
  it("allows it again once the guard window has passed, or when the stored time is in the future", () => {
    expect(viewerReloadAllowed(now - VIEWER_RELOAD_GUARD_MS, now)).toBe(true)
    expect(viewerReloadAllowed(now + 60_000, now)).toBe(true)
  })
})

describe("server clock samples (§2.7)", () => {
  const at = "2026-09-23T10:00:00.000Z"
  const hello: ServerEvent = { type: "hello", serverNow: at, buildId: "b", version: "2.0.0", viewerId: "u1" }
  it("live hello, heartbeat and reservation.changed are samples", () => {
    expect(clockSampleOf(hello, false)).toBe(at)
    expect(clockSampleOf({ type: "heartbeat", serverNow: at }, false)).toBe(at)
    expect(clockSampleOf({
      type: "reservation.changed", equipmentId: "e1", equipmentName: "Equipo A", reservation: null, cause: "release", byName: null, serverNow: at,
    }, false)).toBe(at)
  })
  it("a replayed hello (the worker's cached one) is never a sample", () => {
    expect(clockSampleOf(hello, true)).toBeNull()
    expect(clockSampleOf({ type: "heartbeat", serverNow: at }, true)).toBeNull()
  })
  it("events without serverNow are not samples", () => {
    expect(clockSampleOf({ type: "viewer.changed", userId: "u1" }, false)).toBeNull()
    expect(clockSampleOf({ type: "toast", level: "info", message: "x" }, false)).toBeNull()
  })
})

describe("worker messages", () => {
  it("parses status and event messages; replay only when exactly true", () => {
    expect(parseWorkerMsg({ kind: "status", status: "open" })).toEqual({ kind: "status", status: "open" })
    expect(parseWorkerMsg({ kind: "event", data: "{}" })).toEqual({ kind: "event", data: "{}", replay: false })
    expect(parseWorkerMsg({ kind: "event", data: "{}", replay: true })).toEqual({ kind: "event", data: "{}", replay: true })
    expect(parseWorkerMsg({ kind: "event", data: "{}", replay: "yes" })).toEqual({ kind: "event", data: "{}", replay: false })
  })
  it("rejects anything else", () => {
    for (const m of [null, undefined, "open", 1, {}, { kind: "status", status: "weird" }, { kind: "event", data: 1 }, { kind: "other", data: "{}" }]) {
      expect(parseWorkerMsg(m)).toBeNull()
    }
  })
})

describe("server toast events (§8.9 forced release)", () => {
  it("warn → a warning that stays longer; info → a default info toast", () => {
    expect(serverToastView({ type: "toast", level: "warn", message: "Ana ha liberado tu reserva de Equipo A: fin de turno" }))
      .toEqual({ tone: "warning", message: "Ana ha liberado tu reserva de Equipo A: fin de turno", duration: SERVER_TOAST_WARN_MS })
    expect(serverToastView({ type: "toast", level: "info", message: " Hola " })).toEqual({ tone: "info", message: "Hola" })
  })
  it("ignores other events and empty or malformed messages", () => {
    expect(serverToastView({ type: "heartbeat", serverNow: "2026-09-23T10:00:00.000Z" })).toBeNull()
    expect(serverToastView({ type: "toast", level: "warn", message: "  " })).toBeNull()
    expect(serverToastView({ type: "toast", level: "warn", message: 42 } as unknown as ServerEvent)).toBeNull()
  })
})
