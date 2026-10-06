"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import type { ConsoleRuntimeDTO } from "@/lib/contracts/serial"
import type { ViewerPresenceDTO, WsMode, WsServerMsg } from "@/lib/contracts/ws"
import { WS_LIMITS } from "@/lib/contracts/ws"
import { PASSWORD_CHANGE_PATH, loginRedirect } from "@/lib/client/action-result"
import { createTimerSlot } from "@/lib/client/timer-slot"
import { initialSocketState, socketReducer, type SocketState } from "./socket-machine"

export type SocketHello = Extract<WsServerMsg, { t: "hello" }>
type ModeReason = Extract<WsServerMsg, { t: "mode" }>["reason"]
type RejectReason = Extract<WsServerMsg, { t: "input-rejected" }>["reason"]

/** Callbacks for the socket's data plane; they may change on every render. */
export interface ConsoleSocketHandlers {
  /** Before the history replay of every (re)connection: the terminal runs `term.reset()` (no duplicated output). */
  onReset?(): void
  onData?(bytes: Uint8Array): void
  onHistoryEnd?(m: { bytes: number; truncated: boolean }): void
  onMode?(mode: WsMode, reason: ModeReason): void
  onGap?(droppedBytes: number): void
  onInputRejected?(reason: RejectReason): void
  onCleared?(byName: string): void
  onServerError?(code: string, message: string): void
}

export interface ConsoleSocket {
  state: SocketState
  hello: SocketHello | null
  runtime: ConsoleRuntimeDTO | null
  viewers: ViewerPresenceDTO[]
  mode: WsMode | null
  /** Sends input bytes (UTF-8) when the session is `rw`; returns false otherwise (nothing is sent). */
  send(data: string | Uint8Array): boolean
  /** BREAK on the line (holder only, server-checked). */
  sendBreak(ms?: number): boolean
  /** Manual reconnect ("Reintentar"). */
  retry(): void
}

const PING_MS = WS_LIMITS.clientPingMs
const MAX_FRAME = WS_LIMITS.maxClientFrameBytes - 1024
const encoder = new TextEncoder()

function wsUrl(path: string): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:"
  return `${proto}//${window.location.host}${path}`
}

/**
 * The console / preview WebSocket (§5, §8.10). The protocol state lives in the pure `socketReducer`; this hook
 * owns one socket per `[path, attempt]` (local `ws`, retry timer and `disposed` flag in the effect), reconnects
 * with backoff, and follows the close-code table (login, password change, refresh, "Demasiadas sesiones").
 * `path` is `/ws/console/<consoleId>` or `/ws/preview/<stableKey>?baud=<n>`; null keeps the socket closed.
 */
export function useConsoleSocket(path: string | null, handlers: ConsoleSocketHandlers = {}): ConsoleSocket {
  const router = useRouter()
  const [state, dispatch] = React.useReducer(socketReducer, undefined, () => (path ? socketReducer(initialSocketState(), { type: "connect" }) : initialSocketState()))
  const [attempt, setAttempt] = React.useState(0)
  const [hello, setHello] = React.useState<SocketHello | null>(null)
  const [runtime, setRuntime] = React.useState<ConsoleRuntimeDTO | null>(null)
  const [viewers, setViewers] = React.useState<ViewerPresenceDTO[]>([])
  const wsRef = React.useRef<WebSocket | null>(null)
  const [refreshRetry] = React.useState(createTimerSlot)
  const modeRef = React.useRef<WsMode | null>(null)

  // A new path starts over (adjusting state while rendering; no effect round trip).
  const [lastPath, setLastPath] = React.useState(path)
  if (lastPath !== path) {
    setLastPath(path)
    dispatch(path ? { type: "manual-retry" } : { type: "dispose" })
    setHello(null)
    setRuntime(null)
    setViewers([])
  }

  const emit = React.useEffectEvent(<K extends keyof ConsoleSocketHandlers>(k: K, ...args: Parameters<NonNullable<ConsoleSocketHandlers[K]>>) => {
    const fn = handlers[k] as ((...a: typeof args) => void) | undefined
    fn?.(...args)
  })

  const onClosed = React.useEffectEvent((code: number) => {
    const s = socketReducer({ kind: "connecting", attempt: 0 }, { type: "close", code, reason: "", at: 0 })
    if (s.kind !== "closed") return
    if (s.action === "login") window.location.assign(loginRedirect(window.location.pathname + window.location.search))
    else if (s.action === "revoked") window.location.assign("/login")
    else if (s.action === "change-password") window.location.assign(PASSWORD_CHANGE_PATH)
    else if (s.action === "refresh") {
      // Console deleted or reconfigured: refresh the page data, then try again (a deleted console answers 4004).
      router.refresh()
      refreshRetry.set(() => {
        dispatch({ type: "manual-retry" })
        setAttempt((a) => a + 1)
      }, 1000)
    }
  })

  // The 4011 retry belongs to this path: cancelled on unmount or when the path changes (another console).
  React.useEffect(() => () => refreshRetry.clear(), [path, refreshRetry])

  React.useEffect(() => {
    if (!path) return
    let disposed = false
    let ping: ReturnType<typeof setInterval> | null = null
    const ws = new WebSocket(wsUrl(path))
    ws.binaryType = "arraybuffer"
    wsRef.current = ws
    modeRef.current = null

    ws.onopen = () => {
      ping = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "ping", at: Date.now() }))
      }, PING_MS)
    }
    ws.onmessage = (ev: MessageEvent<ArrayBuffer | string>) => {
      if (disposed) return
      if (typeof ev.data !== "string") {
        emit("onData", new Uint8Array(ev.data))
        return
      }
      let msg: WsServerMsg
      try {
        msg = JSON.parse(ev.data) as WsServerMsg
      } catch {
        return
      }
      switch (msg.t) {
        case "hello": {
          const mode: WsMode = msg.kind === "console" ? msg.mode : "ro"
          modeRef.current = mode
          emit("onReset")
          setHello(msg)
          setRuntime(msg.runtime)
          setViewers(msg.kind === "console" ? msg.viewers : [])
          dispatch({ type: "hello", mode, at: Date.now() })
          break
        }
        case "history-end":
          dispatch({ type: "history-end" })
          emit("onHistoryEnd", { bytes: msg.bytes, truncated: msg.truncated })
          break
        case "status":
          setRuntime(msg.runtime)
          break
        case "mode":
          modeRef.current = msg.mode
          dispatch({ type: "mode", mode: msg.mode })
          emit("onMode", msg.mode, msg.reason)
          break
        case "viewers":
          setViewers(msg.viewers)
          break
        case "gap":
          emit("onGap", msg.droppedBytes)
          break
        case "input-rejected":
          emit("onInputRejected", msg.reason)
          break
        case "cleared":
          emit("onCleared", msg.byName)
          break
        case "error":
          emit("onServerError", msg.code, msg.message)
          break
        case "pong":
          break
      }
    }
    ws.onclose = (ev) => {
      if (ping) clearInterval(ping)
      if (disposed) return
      modeRef.current = null
      dispatch({ type: "close", code: ev.code, reason: ev.reason, at: Date.now() })
      onClosed(ev.code)
    }
    return () => {
      disposed = true
      if (ping) clearInterval(ping)
      ws.onopen = null
      ws.onmessage = null
      ws.onclose = null
      if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) ws.close(1000)
      if (wsRef.current === ws) wsRef.current = null
    }
  }, [path, attempt])

  // Backoff timer (0.5 s … 10 s; 4008 immediately; nothing for 4009/4004/4001…).
  React.useEffect(() => {
    if (state.kind !== "closed" || state.retryInMs === null) return
    const t = setTimeout(() => {
      dispatch({ type: "retry" })
      setAttempt((a) => a + 1)
    }, state.retryInMs)
    return () => clearTimeout(t)
  }, [state])

  const send = React.useCallback((data: string | Uint8Array): boolean => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN || modeRef.current !== "rw") return false
    const bytes = typeof data === "string" ? encoder.encode(data) : data
    for (let i = 0; i < bytes.length; i += MAX_FRAME) ws.send(bytes.subarray(i, i + MAX_FRAME))
    return true
  }, [])

  const sendBreak = React.useCallback((ms = 250): boolean => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN || modeRef.current !== "rw") return false
    ws.send(JSON.stringify({ t: "break", ms }))
    return true
  }, [])

  const retry = React.useCallback(() => {
    dispatch({ type: "manual-retry" })
    setAttempt((a) => a + 1)
  }, [])

  return { state, hello, runtime, viewers, mode: state.kind === "open" ? state.mode : null, send, sendBreak, retry }
}
