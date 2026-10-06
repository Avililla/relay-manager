// Console and preview WebSockets (§5): authenticated, authorised, capped, registered as live sessions.
import type { IncomingMessage } from "node:http"
import type { Duplex } from "node:stream"
import { WebSocketServer, type RawData, type WebSocket } from "ws"
import type { PrismaClient } from "@/generated/prisma/client"
import { WS_CLOSE, WS_LIMITS, WsClientMessageSchema, type WsMode, type WsServerMsg } from "@/lib/contracts/ws"
import { WS_MESSAGE, WS_REASON } from "@/lib/i18n/serial"
import { consoleForUser } from "@/server/access"
import type { Logger } from "@/server/log"
import { normalizeIp } from "@/server/request-meta"
import type {
  AuditService, AuthenticatedSession, AuthUser, EventBus, LiveSession, SessionRegistry, UpgradeTarget, UserActor,
} from "@/server/runtime/types"
import type { ConsoleManagerImpl, ConsoleSessionLike } from "./console-manager"
import { WsPeer } from "./console-session"
import type { PreviewManager, PreviewSessionLike } from "./preview"

export interface WsHandlerDeps {
  prisma: PrismaClient
  bus: EventBus
  audit: AuditService
  log: Logger
  sessions: SessionRegistry
  authenticate(req: IncomingMessage): Promise<AuthenticatedSession | null>
  manager: ConsoleManagerImpl
  previews: PreviewManager
  handshakeTimeoutMs?: number
  heartbeatMs?: number
}

export interface WsHandler {
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, target: UpgradeTarget): void
  closeAll(code: number, reason: string): Promise<void>
  count(): number
  stop(): void
}

class SessionCaps {
  private readonly perKey = new Map<string, number>()
  private readonly perUser = new Map<string, number>()
  private total = 0
  private readonly handshakes = new Map<string, number[]>()

  /** At most 30 handshakes per minute per user. */
  handshake(userId: string): boolean {
    const t = Date.now()
    const list = (this.handshakes.get(userId) ?? []).filter((x) => t - x < 60_000)
    list.push(t)
    this.handshakes.set(userId, list)
    return list.length <= WS_LIMITS.maxHandshakesPerUserPerMin
  }

  tryAcquire(userId: string, key: string): boolean {
    const k = `${userId}|${key}`
    if (this.total >= WS_LIMITS.maxSessionsPerServer) return false
    if ((this.perUser.get(userId) ?? 0) >= WS_LIMITS.maxSessionsPerUser) return false
    if ((this.perKey.get(k) ?? 0) >= WS_LIMITS.maxSessionsPerUserPerConsole) return false
    this.total++
    this.perUser.set(userId, (this.perUser.get(userId) ?? 0) + 1)
    this.perKey.set(k, (this.perKey.get(k) ?? 0) + 1)
    return true
  }

  release(userId: string, key: string): void {
    const k = `${userId}|${key}`
    this.total = Math.max(0, this.total - 1)
    const u = (this.perUser.get(userId) ?? 1) - 1
    if (u > 0) this.perUser.set(userId, u)
    else this.perUser.delete(userId)
    const c = (this.perKey.get(k) ?? 1) - 1
    if (c > 0) this.perKey.set(k, c)
    else this.perKey.delete(k)
  }
}

let connSeq = 0

class Conn implements ConsoleSessionLike, PreviewSessionLike {
  readonly id = ++connSeq
  mode: WsMode = "ro"
  invalid = 0
  cleaned = false
  unregister: (() => void) | null = null
  readonly openedAt = Date.now()

  constructor(
    readonly peer: WsPeer,
    readonly kind: "console" | "preview",
    readonly capKey: string,
    public user: AuthUser,
    readonly ip: string,
    readonly consoleId: string,
    readonly equipmentId: string | null,
  ) {}

  get userId(): string { return this.user.id }
  get name(): string { return this.user.name }
  get username(): string { return this.user.username }
  get actor(): UserActor { return { kind: "user", id: this.user.id, name: this.user.username, ip: this.ip } }

  sendJson(m: WsServerMsg): void { this.peer.sendJson(m) }
  sendBinary(chunk: Buffer, opts?: { history?: boolean }): void { this.peer.sendBinary(chunk, opts) }
  close(code: number, reason: string): void { this.peer.close(code, reason) }
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data
  if (Array.isArray(data)) return Buffer.concat(data)
  return Buffer.from(data)
}

export function createWsHandler(d: WsHandlerDeps): WsHandler {
  const log = d.log.child("ws")
  const wss = new WebSocketServer({ noServer: true, maxPayload: WS_LIMITS.maxClientFrameBytes, clientTracking: false })
  const conns = new Set<Conn>()
  const caps = new SessionCaps()
  const handshakeMs = d.handshakeTimeoutMs ?? WS_LIMITS.handshakeTimeoutMs

  const tick = setInterval(() => { for (const c of conns) c.peer.tick() }, 250)
  tick.unref()
  const beat = setInterval(() => { for (const c of conns) c.peer.heartbeat() }, d.heartbeatMs ?? WS_LIMITS.serverPingMs)
  beat.unref()
  // Visibility can change under an open console socket (roles edited): re-check and close 4004 when lost (§5.6).
  const unsubscribe = d.bus.subscribe((e) => {
    if (e.type !== "equipment.changed") return
    for (const c of conns) if (c.kind === "console" && c.equipmentId === e.equipmentId) void recheck(c)
  })

  async function recheck(c: Conn): Promise<void> {
    try {
      const vis = await consoleForUser(d.prisma, c.user, c.consoleId)
      if (!vis) c.close(WS_CLOSE.NOT_FOUND, WS_REASON.notFound)
    } catch (err) {
      log.error("Error al revalidar una consola abierta", { err })
    }
  }

  function cleanup(c: Conn): void {
    if (c.cleaned) return
    c.cleaned = true
    conns.delete(c)
    caps.release(c.user.id, c.capKey)
    c.unregister?.()
    if (c.kind === "console") {
      d.manager.detachSession(c)
      const eq = d.manager.equipmentOf(c.consoleId)
      d.audit.record({
        actor: c.actor, action: "console.session.close",
        equipment: eq ? { id: eq.equipmentId, name: eq.equipmentName } : null,
        target: { type: "console", id: c.consoleId, name: eq?.key ?? null },
        detail: { mode: c.mode, seconds: Math.round((Date.now() - c.openedAt) / 1000), bytesIn: c.peer.bytesIn, bytesOut: c.peer.bytesOut },
      })
    } else {
      d.previews.leave(c)
    }
  }

  function onMessage(c: Conn, data: RawData, isBinary: boolean): void {
    try {
      const buf = toBuffer(data)
      if (isBinary) {
        c.peer.bytesIn += buf.length
        if (c.kind === "console") d.manager.write(c, buf) // preview: input is ignored, never written
        return
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(buf.toString("utf8"))
      } catch {
        parsed = undefined
      }
      const r = WsClientMessageSchema.safeParse(parsed)
      if (!r.success) {
        c.invalid++
        c.sendJson({ t: "error", code: "PROTOCOL", message: WS_MESSAGE.invalidFrame })
        if (c.invalid >= 10) c.close(WS_CLOSE.PROTOCOL, WS_REASON.protocol)
        return
      }
      if (r.data.t === "ping") c.sendJson({ t: "pong", at: r.data.at, serverNow: new Date().toISOString() })
      else if (r.data.t === "break" && c.kind === "console") void d.manager.sendBreak(c, r.data.ms)
    } catch (err) {
      log.error("Error al procesar un mensaje del WebSocket", { err })
    }
  }

  function wire(ws: WebSocket, c: Conn): void {
    conns.add(c)
    ws.on("message", (data, isBinary) => onMessage(c, data, isBinary))
    ws.on("pong", () => c.peer.pong())
    ws.on("close", () => {
      try { cleanup(c) } catch (err) { log.error("Error al cerrar una sesión", { err }) }
    })
    ws.on("error", () => { /* followed by close */ })
  }

  function liveSession(c: Conn, auth: AuthenticatedSession): LiveSession {
    return {
      userId: auth.user.id, sv: auth.sv, loginAt: auth.loginAt, kind: c.kind,
      revoke: (reason) => c.close(reason === "revoked" ? WS_CLOSE.SESSION_REVOKED : WS_CLOSE.UNAUTHENTICATED, reason === "revoked" ? WS_REASON.revoked : WS_REASON.expired),
      refresh: (u) => {
        c.user = u
        if (c.kind === "preview") {
          if (!u.isAdmin) c.close(WS_CLOSE.NOT_FOUND, WS_REASON.previewAdminOnly)
        } else {
          void recheck(c)
        }
      },
    }
  }

  async function onSocket(ws: WebSocket, auth: AuthenticatedSession | null, target: UpgradeTarget, ip: string, finish: () => void): Promise<void> {
    ws.on("error", () => { /* followed by close */ })
    const peer = new WsPeer(ws)
    const refuse = (code: number, reason: string) => {
      finish()
      peer.close(code, reason)
    }
    if (!auth) return refuse(WS_CLOSE.UNAUTHENTICATED, WS_REASON.unauthenticated)
    const user = auth.user
    if (user.mustChangePassword) return refuse(WS_CLOSE.PASSWORD_CHANGE, WS_REASON.passwordChange)
    if (!caps.handshake(user.id)) return refuse(WS_CLOSE.TOO_MANY_SESSIONS, WS_REASON.tooMany)

    if (target.kind === "console") {
      const vis = await consoleForUser(d.prisma, user, target.consoleId)
      // The client may have gone during the lookup: its close event has already fired, so wiring it now would
      // leak a cap slot and a live session.
      if (ws.readyState !== ws.OPEN) return finish()
      if (!vis || !d.manager.has(target.consoleId)) return refuse(WS_CLOSE.NOT_FOUND, WS_REASON.notFound)
      const capKey = `console:${target.consoleId}`
      if (!caps.tryAcquire(user.id, capKey)) return refuse(WS_CLOSE.TOO_MANY_SESSIONS, WS_REASON.tooMany)
      const c = new Conn(peer, "console", capKey, user, ip, target.consoleId, vis.id)
      wire(ws, c)
      c.unregister = d.sessions.register(liveSession(c, auth))
      const ok = d.manager.attachSession(c)
      finish()
      if (!ok) return c.close(WS_CLOSE.NOT_FOUND, WS_REASON.notFound)
      d.audit.record({
        actor: c.actor, action: "console.session.open", equipment: { id: vis.id, name: vis.name },
        target: { type: "console", id: vis.consoleId, name: vis.key }, detail: { mode: c.mode },
      })
      return
    }

    // Preview: admin only (§5.7); a denial is audited like any other FORBIDDEN.
    const actor: UserActor = { kind: "user", id: user.id, name: user.username, ip }
    if (!user.isAdmin) {
      d.audit.record({ actor, action: "auth.denied", outcome: "denied", target: { type: "port", id: target.stableKey.slice(0, 200) }, detail: { operation: "console.preview", code: "FORBIDDEN" } })
      return refuse(WS_CLOSE.NOT_FOUND, WS_REASON.previewAdminOnly)
    }
    const capKey = `preview:${target.stableKey}`
    if (!caps.tryAcquire(user.id, capKey)) return refuse(WS_CLOSE.TOO_MANY_SESSIONS, WS_REASON.tooMany)
    const c = new Conn(peer, "preview", capKey, user, ip, "", null)
    wire(ws, c)
    c.unregister = d.sessions.register(liveSession(c, auth))
    const joined = await d.previews.join(target.stableKey, target.baudRate, c, actor)
    finish()
    // The socket may have gone during a slow open (client left, handshake guard): its cleanup already ran, so hand the
    // port back here (leave() is idempotent; the manager also refuses to adopt a session that left while pending).
    if (joined && (c.cleaned || ws.readyState !== ws.OPEN)) d.previews.leave(c)
  }

  return {
    handleUpgrade(req, socket, head, target) {
      let done = false
      // A socket that is neither sent its hello nor closed within 10 s is destroyed (§2.9).
      const guard: NodeJS.Timeout = setTimeout(() => { if (!done) socket.destroy() }, handshakeMs)
      guard.unref()
      const finish = () => {
        done = true
        clearTimeout(guard)
      }
      const ip = normalizeIp(req.socket.remoteAddress ?? "")
      const run = async () => {
        let auth: AuthenticatedSession | null = null
        try {
          auth = await d.authenticate(req)
        } catch {
          auth = null
        }
        if (socket.destroyed) return finish()
        wss.handleUpgrade(req, socket, head, (ws) => {
          onSocket(ws, auth, target, ip, finish).catch((err: unknown) => {
            finish()
            log.error("Error al abrir el WebSocket", { err })
            try { ws.close(WS_CLOSE.INTERNAL, WS_REASON.internal) } catch { ws.terminate() }
          })
        })
      }
      run().catch((err: unknown) => {
        finish()
        log.error("Error al atender el WebSocket", { err })
        socket.destroy()
      })
    },
    async closeAll(code, reason) {
      for (const c of [...conns]) c.close(code, reason)
      await d.previews.closeAll()
    },
    count: () => conns.size,
    stop() {
      clearInterval(tick)
      clearInterval(beat)
      unsubscribe()
      wss.close()
    },
  }
}
