// Live read-only preview of a free port (§4.7, §5.7): one shared port per stableKey, refcounted across sockets.
import { BAUD_RATES, DEFAULT_LINE } from "@/lib/contracts/enums"
import type { ConsoleRuntimeDTO } from "@/lib/contracts/serial"
import { WS_CLOSE, WS_LIMITS, type WsServerMsg } from "@/lib/contracts/ws"
import { WS_REASON } from "@/lib/i18n/serial"
import type { Logger } from "@/server/log"
import type { ActorRef, AuditService } from "@/server/runtime/types"
import type { DeviceView, PortUsage } from "./console-manager"
import { mapOpenError, openWithDeadline, type PortHandle, type PortOpener } from "./port-factory"
import { ByteRing } from "./pure/byte-ring"
import { LineTracker } from "./pure/line-tracker"

export interface PreviewSessionLike {
  readonly id: number
  sendJson(msg: WsServerMsg): void
  sendBinary(chunk: Buffer, opts?: { history?: boolean }): void
  close(code: number, reason: string): void
}

interface Entry {
  key: string
  devNode: string
  baud: number
  handle: PortHandle | null
  opening: Promise<boolean> | null
  ring: ByteRing
  line: LineTracker
  lastRxAt: Date | null
  openedAt: Date
  sessions: Set<PreviewSessionLike>
  graceTimer: NodeJS.Timeout | null
  idleTimer: NodeJS.Timeout | null
  closed: boolean
  failure: string | null
}

const PREVIEW_OPEN_TIMEOUT_MS = 8000

export interface PreviewDeps {
  discovery: DeviceView
  openPort: PortOpener
  usage: PortUsage
  audit: AuditService
  log: Logger
  /** "bound": a console is bound to it; "held": the console manager has it open; null: free. */
  claim(stableKey: string): "bound" | "held" | null
  graceMs?: number
  maxIdleMs?: number
  /**
   * A hung open gives up after this, so closeForStableKey never waits on it forever. The default (8 s) is below the
   * 10 s WS handshake guard, so the viewer gets a clean 4004 with the reason instead of a dropped socket.
   */
  openTimeoutMs?: number
}

export class PreviewManager {
  private readonly entries = new Map<string, Entry>()
  private readonly bySession = new Map<number, Entry>()
  /** Sessions waiting in join() for their port to open; leave() marks them so join() never adopts a gone socket. */
  private readonly pending = new Map<number, { left: boolean }>()
  private readonly log: Logger

  constructor(private readonly d: PreviewDeps) {
    this.log = d.log.child("serial")
  }

  isOpen(stableKey: string): boolean {
    const e = this.entries.get(stableKey)
    return !!e?.handle && !e.closed
  }

  buffer(stableKey: string): Buffer | null {
    const e = this.entries.get(stableKey)
    return e?.handle && !e.closed ? e.ring.tail(8192) : null
  }

  sessionCount(): number { return this.bySession.size }

  /** Admin already checked by ws.ts. Sends hello + ring + history-end, or closes 4004 with the reason. */
  async join(stableKey: string, baudRate: number, s: PreviewSessionLike, actor: ActorRef): Promise<boolean> {
    if (!(BAUD_RATES as readonly number[]).includes(baudRate)) return this.refuse(s, WS_REASON.previewBaud)
    const dev = this.d.discovery.find(stableKey)
    if (!dev) return this.refuse(s, WS_REASON.previewMissing)
    const claim = this.d.claim(stableKey)
    if (claim === "bound") return this.refuse(s, WS_REASON.previewBound)
    if (claim === "held") return this.refuse(s, WS_REASON.previewInUse)
    let e = this.entries.get(stableKey)
    if (!e || e.closed) {
      const entry: Entry = {
        key: stableKey, devNode: dev.devNode, baud: baudRate, handle: null, opening: null,
        ring: new ByteRing(WS_LIMITS.historyChunkBytes), line: new LineTracker(), lastRxAt: null, openedAt: new Date(),
        sessions: new Set(), graceTimer: null, idleTimer: null, closed: false, failure: null,
      }
      e = entry
      this.entries.set(stableKey, entry)
      entry.opening = this.openEntry(entry, dev.openPath, actor)
    }
    const ticket = { left: false }
    this.pending.set(s.id, ticket)
    let ok: boolean
    try {
      ok = e.opening ? await e.opening : !!e.handle
    } finally {
      if (this.pending.get(s.id) === ticket) this.pending.delete(s.id)
    }
    if (ticket.left) {
      // The socket went away while the port was opening (client gone, handshake guard): never adopt it, and let the
      // port go on the usual grace like any last viewer leaving (§4.7), instead of holding it open and flocked for good.
      if (ok && !e.closed && e.sessions.size === 0) this.scheduleGrace(e)
      return false
    }
    if (!ok || e.closed) return this.refuse(s, e.failure ?? WS_REASON.previewGone)
    if (e.graceTimer) clearTimeout(e.graceTimer)
    e.graceTimer = null
    e.sessions.add(s)
    this.bySession.set(s.id, e)
    const hist = e.ring.snapshot()
    s.sendJson({
      t: "hello", protocol: 1, kind: "preview", stableKey, devNode: e.devNode, baudRate: e.baud,
      runtime: this.runtimeOf(e), historyBytes: hist.length, serverNow: new Date().toISOString(),
    })
    if (hist.length) s.sendBinary(hist, { history: true })
    s.sendJson({ t: "history-end", bytes: hist.length, truncated: e.ring.truncated })
    return true
  }

  /** Idempotent. Also valid while join() is still waiting for the port: join() then refuses to adopt the session. */
  leave(s: PreviewSessionLike): void {
    const p = this.pending.get(s.id)
    if (p) {
      p.left = true
      this.pending.delete(s.id)
    }
    const e = this.bySession.get(s.id)
    this.bySession.delete(s.id)
    if (!e) return
    e.sessions.delete(s)
    if (e.sessions.size === 0 && !e.closed) this.scheduleGrace(e)
  }

  private scheduleGrace(e: Entry): void {
    if (e.graceTimer) clearTimeout(e.graceTimer)
    e.graceTimer = setTimeout(() => { void this.closeEntry(e) }, this.d.graceMs ?? 5000)
    e.graceTimer.unref()
  }

  /** A console was bound to this port: close its previews now (4004 with the reason) and wait for the port. */
  async closeForStableKey(stableKey: string, reason: string): Promise<void> {
    const e = this.entries.get(stableKey)
    if (!e) return
    if (e.opening) await e.opening
    for (const s of [...e.sessions]) {
      this.bySession.delete(s.id)
      s.close(WS_CLOSE.NOT_FOUND, reason)
    }
    e.sessions.clear()
    await this.closeEntry(e)
  }

  async closeAll(): Promise<void> {
    for (const e of [...this.entries.values()]) {
      for (const s of [...e.sessions]) s.close(WS_CLOSE.GOING_AWAY, WS_REASON.shutdown)
      e.sessions.clear()
      await this.closeEntry(e)
    }
    this.bySession.clear()
  }

  private refuse(s: PreviewSessionLike, reason: string): false {
    s.close(WS_CLOSE.NOT_FOUND, reason)
    return false
  }

  private runtimeOf(e: Entry): ConsoleRuntimeDTO {
    return {
      status: e.handle ? "open" : "opening", devNode: e.devNode, detail: null, since: e.openedAt.toISOString(),
      lastRxAt: e.lastRxAt?.toISOString() ?? null, lastLine: e.line.lastLine(), viewers: e.sessions.size, released: null, capture: "off",
    }
  }

  private async openEntry(e: Entry, openPath: string, actor: ActorRef): Promise<boolean> {
    try {
      const h = await openWithDeadline(this.d.openPort, { path: openPath, line: { ...DEFAULT_LINE, baudRate: e.baud }, hupcl: false }, this.d.openTimeoutMs ?? PREVIEW_OPEN_TIMEOUT_MS)
      if (e.closed) {
        await h.close().catch(() => undefined)
        return false
      }
      e.handle = h
      this.d.usage.busy.delete(e.key)
      h.onData((chunk) => {
        try {
          e.ring.push(chunk)
          e.line.push(chunk)
          e.lastRxAt = new Date()
          for (const s of e.sessions) s.sendBinary(chunk)
        } catch (err) {
          this.log.error("Error en la vista previa", { err })
        }
      })
      h.onClose(() => {
        for (const s of [...e.sessions]) {
          this.bySession.delete(s.id)
          s.close(WS_CLOSE.NOT_FOUND, WS_REASON.previewGone)
        }
        e.sessions.clear()
        void this.closeEntry(e)
      })
      // Safety cap: a preview port never stays open more than 120 s without viewers.
      e.idleTimer = setInterval(() => {
        if (e.sessions.size === 0 && Date.now() - e.openedAt.getTime() >= (this.d.maxIdleMs ?? 120_000)) void this.closeEntry(e)
      }, Math.min(10_000, this.d.maxIdleMs ?? 120_000))
      e.idleTimer.unref()
      this.d.audit.record({ actor: { kind: actor.kind, id: actor.id, name: actor.name, ip: actor.ip ?? null }, action: "console.preview", target: { type: "port", id: e.key, name: e.devNode }, detail: { stableKey: e.key, baudRate: e.baud } })
      return true
    } catch (err) {
      const m = mapOpenError(err)
      if (m.kind === "busy") this.d.usage.busy.add(e.key)
      this.log.warn("No se pudo abrir la vista previa", { dispositivo: e.devNode, causa: m.message })
      e.failure = m.detail
      e.closed = true
      if (this.entries.get(e.key) === e) this.entries.delete(e.key)
      return false
    } finally {
      e.opening = null
    }
  }

  private async closeEntry(e: Entry): Promise<void> {
    if (e.graceTimer) clearTimeout(e.graceTimer)
    if (e.idleTimer) clearInterval(e.idleTimer)
    e.graceTimer = null
    e.idleTimer = null
    e.closed = true
    if (this.entries.get(e.key) === e) this.entries.delete(e.key)
    const h = e.handle
    e.handle = null
    if (h) await h.close().catch(() => undefined)
  }
}
