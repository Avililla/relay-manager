// Pure pieces of the client events runtime (§8.11) that EventsProvider wires to the transport.
import type { IsoDate } from "@/lib/contracts/common"
import type { ServerEvent } from "@/lib/contracts/events"

export const CONNECTION_STATES = ["connecting", "open", "reconnecting", "closed"] as const
export type ConnectionState = (typeof CONNECTION_STATES)[number]

/**
 * A message from `public/events-worker.js`. `replay` marks the cached `hello` the worker hands to a tab that joins
 * a stream that is already open (a new tab, or one restored from the back/forward cache). Anything else is null.
 */
export type WorkerMsg = { kind: "status"; status: ConnectionState } | { kind: "event"; data: string; replay: boolean }

export function parseWorkerMsg(m: unknown): WorkerMsg | null {
  if (typeof m !== "object" || m === null) return null
  const { kind, status, data, replay } = m as { kind?: unknown; status?: unknown; data?: unknown; replay?: unknown }
  if (kind === "status" && (CONNECTION_STATES as readonly unknown[]).includes(status)) return { kind, status: status as ConnectionState }
  if (kind === "event" && typeof data === "string") return { kind, data, replay: replay === true }
  return null
}

/**
 * The `serverNow` an event adds to the server clock (§2.7), or null. Live hello, heartbeat and reservation.changed
 * events are samples. A replayed event never is: the worker's cached hello is as old as the stream (hours, on a
 * long-lived stream), and averaging it with the seed would skew every countdown by half the stream's age.
 */
export function clockSampleOf(e: ServerEvent, replay: boolean): IsoDate | null {
  if (replay) return null
  return e.type === "hello" || e.type === "heartbeat" || e.type === "reservation.changed" ? e.serverNow : null
}

/** A forced release (§8.9) stays up longer than the sonner default: the holder may be looking elsewhere. */
export const SERVER_TOAST_WARN_MS = 10_000

export interface ServerToastView {
  tone: "warning" | "info"
  message: string
  duration?: number
}

/** How a server `toast` event (§4.13, audience user) is shown on any page. Empty or malformed messages: null. */
export function serverToastView(e: ServerEvent): ServerToastView | null {
  if (e.type !== "toast") return null
  const message = typeof e.message === "string" ? e.message.trim() : ""
  if (!message) return null
  return e.level === "warn" ? { tone: "warning", message, duration: SERVER_TOAST_WARN_MS } : { tone: "info", message }
}

export type HelloDecision = "accept" | "reconnect" | "reload" | "ignore"

/**
 * What a `hello` means for a page rendered for `viewerId`. The stream may have been opened with another session's
 * cookie (a sign-in in another tab of the same browser shares the SharedWorker stream), so a foreign viewer gets
 * ONE reconnect with the current cookie. A second foreign hello in a row means the cookie now belongs to someone
 * else and this page is stale: reload it. After that, foreign hellos are ignored until ours arrives again.
 * Never answers "reconnect" twice in a row, so a mismatch can not turn into a reconnect loop.
 */
export function createHelloGuard(viewerId: string): (helloViewerId: string) => HelloDecision {
  let reconnected = false
  let gaveUp = false
  return (helloViewerId) => {
    if (helloViewerId === viewerId) {
      reconnected = false
      gaveUp = false
      return "accept"
    }
    if (gaveUp) return "ignore"
    if (!reconnected) {
      reconnected = true
      return "reconnect"
    }
    gaveUp = true
    return "reload"
  }
}

/** A viewer-change reload less than this long after the previous one (same tab) is skipped: no reload loops. */
export const VIEWER_RELOAD_GUARD_MS = 15_000

/** `lastReloadAt` is the stored timestamp of the previous viewer-change reload in this tab (NaN or 0 = none). */
export function viewerReloadAllowed(lastReloadAt: number, now: number): boolean {
  return !(lastReloadAt > 0 && now - lastReloadAt >= 0 && now - lastReloadAt < VIEWER_RELOAD_GUARD_MS)
}
