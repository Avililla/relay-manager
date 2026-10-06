// Console WebSocket protocol state machine (§5.4, §8.10): a pure reducer, unit-tested.
// idle → connecting → open(ro|rw) → closed(code); the hook turns `retryInMs` into a timer.
import { WS_CLOSE, type WsMode } from "@/lib/contracts/ws"

/** What the client does after a close code (§5.4). */
export type CloseAction =
  | "none"              // 1000 normal
  | "reconnect"         // 1001, 1011, 1006 and unknown codes: backoff
  | "reconnect-now"     // 4008 slow consumer
  | "login"             // 4001 → /login?next=…
  | "change-password"   // 4003 → /cuenta?cambiar=1
  | "protocol-error"    // 4002 → show error, manual reconnect
  | "not-found"         // 4004 → "Consola no disponible", no reconnect
  | "too-many"          // 4009 → "Demasiadas sesiones abiertas…" + "Reintentar", no automatic reconnect
  | "revoked"           // 4010 → /login
  | "refresh"           // 4011 → router.refresh()

export const BACKOFF_MS = [500, 1000, 2000, 5000, 10000] as const
/** A connection that stayed open this long resets the backoff. */
export const CONNECTED_RESET_MS = 30_000

export type SocketState =
  | { kind: "idle"; attempt: number }
  | { kind: "connecting"; attempt: number }
  | { kind: "open"; attempt: number; mode: WsMode; historyDone: boolean; openedAt: number }
  | { kind: "closed"; attempt: number; code: number; reason: string; action: CloseAction; retryInMs: number | null }

export type SocketEvent =
  | { type: "connect" }
  | { type: "hello"; mode: WsMode; at: number }
  | { type: "history-end" }
  | { type: "mode"; mode: WsMode }
  | { type: "close"; code: number; reason: string; at: number }
  | { type: "retry" }          // the backoff timer fired
  | { type: "manual-retry" }   // the user pressed "Reintentar"
  | { type: "dispose" }

export function initialSocketState(): SocketState {
  return { kind: "idle", attempt: 0 }
}

export function backoffMs(attempt: number): number {
  return BACKOFF_MS[Math.min(Math.max(0, attempt), BACKOFF_MS.length - 1)]
}

export function closeAction(code: number): CloseAction {
  switch (code) {
    case WS_CLOSE.NORMAL: return "none"
    case WS_CLOSE.UNAUTHENTICATED: return "login"
    case WS_CLOSE.PROTOCOL: return "protocol-error"
    case WS_CLOSE.PASSWORD_CHANGE: return "change-password"
    case WS_CLOSE.NOT_FOUND: return "not-found"
    case WS_CLOSE.SLOW_CONSUMER: return "reconnect-now"
    case WS_CLOSE.TOO_MANY_SESSIONS: return "too-many"
    case WS_CLOSE.SESSION_REVOKED: return "revoked"
    case WS_CLOSE.CONSOLE_CHANGED: return "refresh"
    default: return "reconnect"
  }
}

export function socketReducer(s: SocketState, e: SocketEvent): SocketState {
  switch (e.type) {
    case "connect":
      return s.kind === "connecting" ? s : { kind: "connecting", attempt: s.attempt }
    case "hello":
      return { kind: "open", attempt: s.attempt, mode: e.mode, historyDone: false, openedAt: e.at }
    case "history-end":
      return s.kind === "open" && !s.historyDone ? { ...s, historyDone: true } : s
    case "mode":
      return s.kind === "open" && s.mode !== e.mode ? { ...s, mode: e.mode } : s
    case "close": {
      if (s.kind === "idle") return s
      const attempt = s.kind === "open" && e.at - s.openedAt >= CONNECTED_RESET_MS ? 0 : s.attempt
      const action = closeAction(e.code)
      const retryInMs = action === "reconnect" ? backoffMs(attempt) : action === "reconnect-now" ? 0 : null
      return { kind: "closed", attempt, code: e.code, reason: e.reason, action, retryInMs }
    }
    case "retry":
      return s.kind === "closed" && s.retryInMs !== null ? { kind: "connecting", attempt: s.attempt + 1 } : s
    case "manual-retry":
      return { kind: "connecting", attempt: 0 }
    case "dispose":
      return { kind: "idle", attempt: 0 }
  }
}
