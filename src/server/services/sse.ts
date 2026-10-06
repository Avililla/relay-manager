// Server-sent events (§4.13, W1-C): one stream per browser, filtered by audience, revalidated through rt.sessions.
// Stateless module: all state lives in the closure of one stream; the shared state is the bus and the session registry.
import type { PrismaClient } from "@/generated/prisma/client"
import type { Audience, ServerEvent } from "@/lib/contracts/events"
import type { AppConfig } from "@/server/config/schema"
import type { Logger } from "@/server/log"
import type { AuthenticatedSession, AuthUser, EventBus, SessionRegistry } from "@/server/runtime/types"
import { visibleEquipmentSet } from "./visibility"

export const SSE_MAX_STREAMS_PER_USER = 8
export const SSE_HEARTBEAT_MS = 15_000
export const SSE_VISIBILITY_DEBOUNCE_MS = 200
export const SSE_RETRY_MS = 3_000
/** Frames queued for a client that stopped reading before the stream is dropped. */
export const SSE_MAX_QUEUED_CHUNKS = 2_000
export const SSE_HEADERS: Readonly<Record<string, string>> = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  "x-accel-buffering": "no",
  connection: "keep-alive",
}

export interface EventStreamDeps {
  bus: EventBus
  sessions: SessionRegistry
  prisma: PrismaClient
  config: AppConfig
  log: Logger
}
type Viewer = Pick<AuthUser, "id" | "isAdmin" | "roleIds">
export type Visible = Set<string> | "all"

export interface EventStreamOptions {
  session: AuthenticatedSession
  signal: AbortSignal
  heartbeatMs?: number
  debounceMs?: number
  /** Visible equipment of the viewer (tests override it). Default: src/server/access.ts through visibility.ts. */
  visibility?: (viewer: Viewer) => Promise<Visible>
  now?: () => Date
}
export type OpenStreamResult = { ok: true; stream: ReadableStream<Uint8Array> } | { ok: false; status: 429 }

/** Audience filter, normative table of §4.13. */
export function audienceMatches(a: Audience, viewer: { id: string; isAdmin: boolean }, visible: Visible): boolean {
  switch (a.kind) {
    case "all": return true
    case "admins": return viewer.isAdmin
    case "user": return a.userId === viewer.id
    case "userAndAdmins": return a.userId === viewer.id || viewer.isAdmin
    case "equipment": return visible === "all" || visible.has(a.equipmentId)
  }
}

export function formatSseEvent(id: number, event: ServerEvent): string {
  return `id: ${id}\ndata: ${JSON.stringify(event)}\n\n`
}

/**
 * Opens one SSE stream. Order (§4.13): subscribe first (buffering) → count/limit and register the live session in the
 * same synchronous block (so two racing requests can never exceed the cap) → visible set → retry + hello → flush → stream.
 */
export function openEventStream(deps: EventStreamDeps, opts: EventStreamOptions): OpenStreamResult {
  const log = deps.log.child("sse")
  const now = opts.now ?? (() => new Date())
  const heartbeatMs = opts.heartbeatMs ?? SSE_HEARTBEAT_MS
  const debounceMs = opts.debounceMs ?? SSE_VISIBILITY_DEBOUNCE_MS
  const viewer: Viewer = { id: opts.session.user.id, isAdmin: opts.session.user.isAdmin, roleIds: [...opts.session.user.roleIds] }
  const enc = new TextEncoder()

  const initialVisibility = opts.visibility ?? ((v: Viewer) => visibleEquipmentSet(deps.prisma, v))
  /** Recompute from a fresh DB read of the viewer (role changes may reach the bus before LiveSession.refresh). */
  const recomputeVisibility = opts.visibility ?? (async (v: Viewer): Promise<Visible> => {
    const u = await deps.prisma.user.findUnique({ where: { id: v.id }, select: { isAdmin: true, disabled: true, roles: { select: { id: true } } } })
    if (!u || u.disabled) return new Set<string>()
    viewer.isAdmin = u.isAdmin
    viewer.roleIds = u.roles.map((r) => r.id)
    return visibleEquipmentSet(deps.prisma, viewer)
  })

  let controller: ReadableStreamDefaultController<Uint8Array> | null = null
  let closed = false
  let ready = false
  let seq = 0
  let visible: Visible = new Set<string>()
  let recomputeTimer: ReturnType<typeof setTimeout> | null = null
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null
  let recomputeGen = 0
  const buffer: Array<[ServerEvent, Audience]> = []

  if (opts.signal.aborted) return { ok: true, stream: new ReadableStream<Uint8Array>({ start: (c) => c.close() }) }

  function write(text: string): void {
    if (closed || !controller) return
    // A stalled client (TCP open, nothing read) must not grow memory without bound: drop it; it reconnects later.
    if ((controller.desiredSize ?? 0) < -SSE_MAX_QUEUED_CHUNKS) {
      log.warn("Cliente SSE sin leer: se cierra el flujo", { usuario: viewer.id })
      close()
      return
    }
    try {
      controller.enqueue(enc.encode(text))
    } catch {
      close()
    }
  }
  function send(event: ServerEvent): void {
    seq += 1
    write(formatSseEvent(seq, event))
  }
  function close(): void {
    if (closed) return
    closed = true
    unsubscribe()
    unregister()
    if (recomputeTimer) clearTimeout(recomputeTimer)
    if (heartbeatTimer) clearInterval(heartbeatTimer)
    recomputeTimer = null
    heartbeatTimer = null
    opts.signal.removeEventListener("abort", close)
    try {
      controller?.close()
    } catch {
      // already closed or errored by the consumer
    }
  }

  function scheduleRecompute(): void {
    if (closed) return
    if (recomputeTimer) clearTimeout(recomputeTimer)
    recomputeTimer = setTimeout(() => {
      recomputeTimer = null
      const gen = ++recomputeGen
      recomputeVisibility(viewer)
        .then((v) => { if (!closed && gen === recomputeGen) visible = v })
        .catch((err: unknown) => log.error("Error al recalcular los equipos visibles", { err }))
    }, debounceMs)
    recomputeTimer.unref?.()
  }

  function deliver(event: ServerEvent, audience: Audience): void {
    if (closed) return
    if (event.type === "equipment.changed" || (event.type === "viewer.changed" && event.userId === viewer.id)) scheduleRecompute()
    if (!audienceMatches(audience, viewer, visible)) return
    send(event)
    if (event.type === "session.revoked" && event.userId === viewer.id) close()
  }

  // 1. Subscribe first, buffering until hello is out.
  const unsubscribe = deps.bus.subscribe((event, audience) => {
    if (closed) return
    if (!ready) buffer.push([event, audience])
    else deliver(event, audience)
  })
  // 2. Stream cap and live-session registration, in the same synchronous block.
  if (deps.sessions.count({ userId: viewer.id, kind: "sse" }) >= SSE_MAX_STREAMS_PER_USER) {
    unsubscribe()
    return { ok: false, status: 429 }
  }
  const unregister = deps.sessions.register({
    userId: viewer.id, sv: opts.session.sv, loginAt: opts.session.loginAt, kind: "sse",
    revoke(reason) {
      if (closed) return
      send({ type: "session.revoked", userId: viewer.id, reason })
      close()
    },
    refresh(user) {
      if (closed) return
      viewer.isAdmin = user.isAdmin
      viewer.roleIds = [...user.roleIds]
      if (!user.isAdmin && visible === "all") visible = new Set<string>()
      scheduleRecompute()
    },
  })
  opts.signal.addEventListener("abort", close, { once: true })

  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
      // 3.–5. Visible set, then retry + hello, then the buffered events.
      void initialVisibility(viewer)
        .catch((err: unknown) => {
          log.error("Error al calcular los equipos visibles", { err })
          return new Set<string>() as Visible
        })
        .then((v) => {
          if (closed) return
          visible = v
          write(`retry: ${SSE_RETRY_MS}\n\n`)
          send({ type: "hello", serverNow: now().toISOString(), buildId: deps.config.build.buildId, version: deps.config.build.version, viewerId: viewer.id })
          ready = true
          for (const [e, a] of buffer.splice(0)) deliver(e, a)
          heartbeatTimer = setInterval(() => {
            write(": ping\n\n")
            send({ type: "heartbeat", serverNow: now().toISOString() })
          }, heartbeatMs)
          heartbeatTimer.unref?.()
        })
    },
    cancel() {
      close()
    },
  })
  return { ok: true, stream }
}
