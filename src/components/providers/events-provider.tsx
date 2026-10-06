"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { signOut } from "next-auth/react"
import { ServerEventEnvelopeSchema, type ServerEvent, type ServerEventType } from "@/lib/contracts/events"
import { loginRedirect } from "@/lib/client/action-result"
import { checkSessionUntilKnown } from "@/lib/client/session-check"
import { isChangingOwnPassword } from "@/components/auth/password-changed-flag"
import {
  clockSampleOf, createHelloGuard, parseWorkerMsg, viewerReloadAllowed, type ConnectionState,
} from "@/lib/client/events-runtime"
import { useServerClock } from "./server-clock-provider"

/**
 * Client events runtime (§8.11). One SSE stream per browser through the SharedWorker `public/events-worker.js`,
 * or a per-tab EventSource where SharedWorker does not exist. Components subscribe with `useServerEvents`.
 */
export type { ConnectionState }
type Handler = (e: ServerEvent) => void

interface EventsContextValue {
  state: ConnectionState
  stale: boolean
  subscribe(types: readonly ServerEventType[] | "*", handler: Handler): () => void
  reconnect(): void
}

const EventsContext = React.createContext<EventsContextValue | null>(null)

/** The connection must have been down this long before live data is shown as stale (§8.9). */
export const STALE_AFTER_MS = 5000
const REFRESH_DEBOUNCE_MS = 300
const TAB_RETRY_MS = [3000, 5000, 10000, 30000]

interface Transport {
  reconnect(): void
  close(): void
}

/** `onData(data, replay)`: `replay` is true for the cached hello the SharedWorker hands a joining tab. */
function openTransport(onStatus: (s: ConnectionState) => void, onData: (data: string, replay: boolean) => void): Transport {
  if (typeof SharedWorker !== "undefined") {
    try {
      const worker = new SharedWorker("/events-worker.js", { name: "rm-events" })
      const port = worker.port
      port.onmessage = (m: MessageEvent<unknown>) => {
        const msg = parseWorkerMsg(m.data)
        if (msg?.kind === "status") onStatus(msg.status)
        else if (msg?.kind === "event") onData(msg.data, msg.replay)
      }
      port.start()
      port.postMessage({ cmd: "hello" })
      const bye = () => port.postMessage({ cmd: "bye" })
      // Restored from the back/forward cache after "bye": join the stream again (the replayed hello resyncs).
      const rejoin = (e: PageTransitionEvent) => {
        if (e.persisted) port.postMessage({ cmd: "hello" })
      }
      window.addEventListener("pagehide", bye)
      window.addEventListener("pageshow", rejoin)
      return {
        reconnect: () => port.postMessage({ cmd: "reconnect" }),
        close: () => {
          window.removeEventListener("pagehide", bye)
          window.removeEventListener("pageshow", rejoin)
          bye()
          port.close()
        },
      }
    } catch {
      // Blocked by policy or unsupported in this context: fall back to a per-tab EventSource.
    }
  }
  let es: EventSource | null = null
  let retry: ReturnType<typeof setTimeout> | null = null
  let attempt = 0
  let seenHello = false
  const open = () => {
    if (retry) clearTimeout(retry)
    retry = null
    es?.close()
    onStatus(seenHello ? "reconnecting" : "connecting")
    const src = new EventSource("/api/events")
    es = src
    src.onopen = () => {
      attempt = 0
      onStatus("open")
    }
    src.onmessage = (ev: MessageEvent<string>) => {
      if (ev.data.includes("\"type\":\"hello\"")) seenHello = true
      onData(ev.data, false)
    }
    src.onerror = () => {
      if (src.readyState === EventSource.CLOSED) {
        onStatus("closed")
        retry = setTimeout(open, TAB_RETRY_MS[Math.min(attempt++, TAB_RETRY_MS.length - 1)])
      } else {
        onStatus("reconnecting")
      }
    }
  }
  open()
  return {
    reconnect: () => {
      attempt = 0
      open()
    },
    close: () => {
      if (retry) clearTimeout(retry)
      es?.close()
      es = null
    },
  }
}

/** setTimeout as a promise that rejects when `signal` aborts (the session-check backoff). */
/** How long a tab that is re-signing in after its own password change waits before checking its session. */
const REAUTH_GRACE_MS = 5000

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("aborted"))
      return
    }
    const onAbort = () => {
      clearTimeout(t)
      reject(new Error("aborted"))
    }
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

const VIEWER_RELOAD_KEY = "rm-viewer-reload"

/**
 * Reloads the page so the server renders it for the session in the cookie. A reload less than 15 s after the
 * previous one in this tab (sessionStorage) is skipped: should the stream ever keep naming another viewer, the
 * tab stays put instead of reloading in a loop.
 */
function reloadForViewerChange(): void {
  try {
    if (!viewerReloadAllowed(Number(window.sessionStorage.getItem(VIEWER_RELOAD_KEY)), Date.now())) return
    window.sessionStorage.setItem(VIEWER_RELOAD_KEY, String(Date.now()))
  } catch {
    // Storage unavailable: reload anyway.
  }
  window.location.reload()
}

function parseEvent(data: string): ServerEvent | null {
  try {
    const raw: unknown = JSON.parse(data)
    return ServerEventEnvelopeSchema.safeParse(raw).success ? (raw as ServerEvent) : null
  } catch {
    return null
  }
}

export function EventsProvider({ viewerId, children }: { viewerId: string; children: React.ReactNode }) {
  const router = useRouter()
  const clock = useServerClock()
  const [state, setState] = React.useState<ConnectionState>("connecting")
  const [stale, setStale] = React.useState(false)
  const [handlers] = React.useState(() => new Map<Handler, readonly ServerEventType[] | "*">())
  const transportRef = React.useRef<Transport | null>(null)

  const dispatch = React.useEffectEvent((e: ServerEvent, replay: boolean) => {
    // A replayed hello still runs the viewer guard, the build check and the resync count, but it is never a clock
    // sample: its serverNow is as old as the shared stream (§2.7).
    const sample = clockSampleOf(e, replay)
    if (sample) clock.addSample(sample)
    for (const [h, types] of handlers) {
      if (types === "*" || types.includes(e.type)) {
        try {
          h(e)
        } catch {
          // A broken subscriber never stops the others.
        }
      }
    }
  })

  // The stream closed: is the session gone, or is the server restarting? Only a definite answer (401, or 200 without
  // a user) sends the tab to /login. A network error or a 5xx is retried with backoff (session-check.ts) until the
  // answer is definite, the stream opens again or the provider unmounts. One check at a time.
  const sessionCheck = React.useRef<AbortController | null>(null)
  const stopSessionCheck = React.useCallback(() => {
    sessionCheck.current?.abort()
    sessionCheck.current = null
  }, [])
  const onClosed = React.useEffectEvent(async () => {
    if (sessionCheck.current) return
    const ac = new AbortController()
    sessionCheck.current = ac
    try {
      // This tab changed its own password and is signing in again: give that time to set the new cookie (the
      // reopened stream aborts this check) rather than reading the old, revoked session.
      if (isChangingOwnPassword()) {
        try {
          await abortableDelay(REAUTH_GRACE_MS, ac.signal)
        } catch {
          return
        }
      }
      const r = await checkSessionUntilKnown({
        fetchSession: () => fetch("/api/auth/session", { cache: "no-store", signal: ac.signal }),
        sleep: abortableDelay,
        signal: ac.signal,
      })
      if (r === "signed-out") window.location.assign(loginRedirect(window.location.pathname + window.location.search))
    } finally {
      if (sessionCheck.current === ac) sessionCheck.current = null
    }
  })

  React.useEffect(() => {
    let hellos = 0
    let refreshTimer: ReturnType<typeof setTimeout> | null = null
    let revoking = false
    // Viewer mismatch: reconnect once with the current cookie, then reload (never a reconnect loop).
    const helloGuard = createHelloGuard(viewerId)
    const transport = openTransport(
      (s) => {
        setState(s)
        if (s === "closed") void onClosed()
        else if (s === "open") stopSessionCheck()
      },
      (data, replay) => {
        const e = parseEvent(data)
        if (!e) return
        if (e.type === "hello") {
          const decision = helloGuard(e.viewerId)
          if (decision !== "accept") {
            // Foreign hellos never reach subscribers or count as a resync.
            if (decision === "reconnect") transport.reconnect()
            else if (decision === "reload") reloadForViewerChange()
            return
          }
          hellos++
          if (hellos > 1) {
            if (refreshTimer) clearTimeout(refreshTimer)
            refreshTimer = setTimeout(() => router.refresh(), REFRESH_DEBOUNCE_MS)
          }
        }
        // The revocation of a password change made in this very tab is for the user's other sessions.
        if (e.type === "session.revoked" && e.reason === "password-changed" && isChangingOwnPassword()) return
        if (e.type === "session.revoked" && e.userId === viewerId && !revoking) {
          revoking = true
          void signOut({ redirect: false }).finally(() => window.location.assign("/login"))
          return
        }
        dispatch(e, replay)
      },
    )
    transportRef.current = transport
    return () => {
      if (refreshTimer) clearTimeout(refreshTimer)
      stopSessionCheck()
      transportRef.current = null
      transport.close()
    }
  }, [viewerId, router, stopSessionCheck])

  // Stale 5 s after the connection stopped being open (§8.11 useStale): ONE timer per outage, started at mount or
  // on the open → not-open edge. Moves between not-open states (closed → connecting → closed while the server
  // answers 401/429/5xx) never restart it; only "open" cancels it and clears the flag.
  const isOpen = state === "open"
  React.useEffect(() => {
    if (isOpen) return
    const t = setTimeout(() => setStale(true), STALE_AFTER_MS)
    return () => {
      clearTimeout(t)
      setStale(false)
    }
  }, [isOpen])

  const subscribe = React.useCallback((types: readonly ServerEventType[] | "*", handler: Handler) => {
    handlers.set(handler, types)
    return () => {
      handlers.delete(handler)
    }
  }, [handlers])
  const reconnect = React.useCallback(() => transportRef.current?.reconnect(), [])

  const value = React.useMemo<EventsContextValue>(
    () => ({ state, stale: !isOpen && stale, subscribe, reconnect }),
    [state, isOpen, stale, subscribe, reconnect],
  )

  return <EventsContext.Provider value={value}>{children}</EventsContext.Provider>
}

function useEventsContext(): EventsContextValue {
  const c = React.useContext(EventsContext)
  if (!c) throw new Error("useServerEvents needs <EventsProvider>")
  return c
}

/** Calls `handler` for every server event of the given types ("*" = all). The handler may change freely. */
export function useServerEvents(types: readonly ServerEventType[] | "*", handler: (e: ServerEvent) => void): void {
  const { subscribe } = useEventsContext()
  const onEvent = React.useEffectEvent(handler)
  const key = types === "*" ? "*" : types.join(",")
  React.useEffect(() => {
    const list: readonly ServerEventType[] | "*" = key === "*" ? "*" : (key.split(",") as ServerEventType[])
    return subscribe(list, (e) => onEvent(e))
  }, [key, subscribe])
}

export function useConnectionState(): ConnectionState {
  return useEventsContext().state
}

/** True when the live connection has not been open for more than 5 s: live components render the stale style. */
export function useStale(): boolean {
  return useEventsContext().stale
}

export function useReconnectEvents(): () => void {
  return useEventsContext().reconnect
}
