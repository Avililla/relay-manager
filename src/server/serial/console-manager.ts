// Console manager (§4.5): keeps every bound, non-released console port open, captures it to disk, fans RX out to
// WebSocket sessions, applies the write rule, and re-acquires ports after a replug.
import type { PrismaClient } from "@/generated/prisma/client"
import type { EnterMode, LineSettings } from "@/lib/contracts/enums"
import { DEFAULT_LINE, EnterModeSchema, LineSettingsSchema, lineSummary, type ConsoleStatus } from "@/lib/contracts/enums"
import { ConsoleBindingRecordSchema, type CaptureFileDTO, type ConsoleBindingRecord, type ConsoleRuntimeDTO, type SerialPortDTO } from "@/lib/contracts/serial"
import { WS_CLOSE, WS_LIMITS, type ViewerPresenceDTO, type WsMode, type WsServerMsg } from "@/lib/contracts/ws"
import type { ReservationCause } from "@/lib/contracts/reservations"
import { errorMessage } from "@/lib/i18n/errors"
import { CAPTURE_MARK, SERIAL_DETAIL, SERIAL_LOG, WS_REASON } from "@/lib/i18n/serial"
import { canWriteConsoleEquipment } from "@/server/authz-rules"
import type { AppConfig } from "@/server/config/schema"
import { DomainError } from "@/server/errors"
import type { Logger } from "@/server/log"
import {
  SYSTEM_ACTOR, type ActorRef, type AuditService, type ConsoleManager, type ConsoleTap, type ConsoleTapHello, type EventBus, type ReservationChange,
  type ReservationService, type SettingsService,
} from "@/server/runtime/types"
import type { CaptureService, ConsoleCapture } from "./capture/service"
import type { SerialDevice } from "./enumerate"
import { resolveBinding } from "./matcher"
import { mapOpenError, OPEN_TIMEOUT_MESSAGE, OPEN_TIMEOUT_MS, type PortHandle, type PortOpener } from "./port-factory"
import { ByteRing } from "./pure/byte-ring"
import { LineTracker } from "./pure/line-tracker"
import { TokenBucket } from "./pure/token-bucket"

export interface DeviceView {
  devices(): readonly SerialDevice[]
  find(stableKey: string): SerialDevice | null
}
/** Ports whose last open attempt failed with "busy" (discovery shows them as in use by another program). */
export interface PortUsage { busy: Set<string> }
export interface PreviewCloser { closeForStableKey(stableKey: string, reason: string): Promise<void> }

/** What the manager needs from a console WebSocket session (ws.ts implements it). */
export interface ConsoleSessionLike {
  readonly id: number
  readonly consoleId: string
  readonly userId: string
  /** Display name (presence). */
  readonly name: string
  /** Username (capture markers, audit). */
  readonly username: string
  readonly ip?: string | null
  mode: WsMode
  sendJson(msg: WsServerMsg): void
  sendBinary(chunk: Buffer, opts?: { history?: boolean }): void
  close(code: number, reason: string): void
}

export interface ConsoleManagerOptions {
  prisma: PrismaClient
  bus: EventBus
  audit: AuditService
  settings: SettingsService
  log: Logger
  config: AppConfig
  reservations: ReservationService
  discovery: DeviceView
  capture: CaptureService
  openPort: PortOpener
  previews: PreviewCloser
  usage: PortUsage
  now?: () => Date
  /** Open retry backoff (§4.5 rule 4). */
  backoffMs?: readonly number[]
  /** Length of a "minute" for release durations (tests shorten it). */
  minuteMs?: number
  /** A hung open gives up after this long (default 10 s). */
  openTimeoutMs?: number
}

/** `displayName` (the user's name, not the username) is what "Puerto soltado por X" shows; audit and logs keep `name`. */
type Actor = ActorRef & { isAdmin: boolean; displayName?: string }

interface ConsoleRow {
  id: string
  equipmentId: string
  equipmentName: string
  key: string
  label: string
  line: LineSettings
  enterMode: EnterMode
  localEcho: boolean
  hupcl: boolean
  captureToDisk: boolean
  binding: ConsoleBindingRecord | null
  bindingInvalid: boolean
  releasedAt: Date | null
  releasedByName: string | null
  releaseUntil: Date | null
}

interface ConsoleState {
  row: ConsoleRow
  status: ConsoleStatus
  devNode: string | null
  detail: string | null
  since: Date
  port: PortHandle | null
  openPath: string | null
  target: string | null
  gen: number
  resolvedKey: string | null
  history: ByteRing
  line: LineTracker
  lastRxAt: Date | null
  sessions: Set<ConsoleSessionLike>
  taps: Set<ConsoleTap>
  capture: ConsoleCapture
  backoffIdx: number
  retryTimer: NodeJS.Timeout | null
  releaseTimer: NodeJS.Timeout | null
  viewersTimer: NodeJS.Timeout | null
  queue: Promise<void>
  deleted: boolean
  act: { at: number; line: string | null; rxAt: number; timer: NodeJS.Timeout | null }
  lastPublished: string
  lastFailure: string | null
}

const DEFAULT_BACKOFF = [1000, 2000, 5000, 10_000, 30_000] as const
const HOLDER_TOUCH_MS = 5000
const PROBLEM: ReadonlySet<ConsoleStatus> = new Set(["missing", "busy", "no-permission", "error"])

type DbConsole = Awaited<ReturnType<PrismaClient["serialConsole"]["findMany"]>>[number] & { equipment: { name: string } }

function mapRow(r: DbConsole): ConsoleRow {
  const line = LineSettingsSchema.safeParse({ baudRate: r.baudRate, dataBits: r.dataBits, parity: r.parity, stopBits: r.stopBits, flowControl: r.flowControl })
  const enter = EnterModeSchema.safeParse(r.enterMode)
  let binding: ConsoleBindingRecord | null = null
  let bindingInvalid = false
  if (r.matchBy !== null) {
    const b = ConsoleBindingRecordSchema.safeParse({
      matchBy: r.matchBy, bindingKey: r.bindingKey ?? "", byId: r.byId, byPath: r.byPath, usbVendorId: r.usbVendorId, usbProductId: r.usbProductId,
      usbSerial: r.usbSerial, usbInterface: r.usbInterface, usbPortNumber: r.usbPortNumber, usbIdPath: r.usbIdPath, devicePath: r.devicePath,
      adapterLabel: r.adapterLabel, lastDevNode: r.lastDevNode,
    })
    if (b.success) binding = b.data
    else bindingInvalid = true
  }
  return {
    id: r.id, equipmentId: r.equipmentId, equipmentName: r.equipment.name, key: r.key, label: r.label,
    line: line.success ? line.data : DEFAULT_LINE, enterMode: enter.success ? enter.data : "cr",
    localEcho: r.localEcho, hupcl: r.hupcl, captureToDisk: r.captureToDisk, binding, bindingInvalid,
    releasedAt: r.releasedAt, releasedByName: r.releasedByName, releaseUntil: r.releaseUntil,
  }
}

function mapEnter(bytes: Buffer, mode: EnterMode): Buffer {
  if (mode === "cr" || !bytes.includes(0x0d)) return bytes
  const repl = mode === "lf" ? [0x0a] : [0x0d, 0x0a]
  const out: number[] = []
  for (const b of bytes) {
    if (b === 0x0d) out.push(...repl)
    else out.push(b)
  }
  return Buffer.from(out)
}

function modeReason(cause: ReservationCause): Extract<WsServerMsg, { t: "mode" }>["reason"] {
  switch (cause) {
    case "expire": return "expired"
    case "force-release": case "user-removed": case "access-lost": return "force-released"
    case "reserve": return "reserved-by-other"
    default: return "released"
  }
}

const hhmmUtc = (d: Date) => `${d.toISOString().slice(11, 16)} UTC`
const plainActor = (a: ActorRef): ActorRef => ({ kind: a.kind, id: a.id, name: a.name, ip: a.ip ?? null })

export class ConsoleManagerImpl implements ConsoleManager {
  private readonly o: ConsoleManagerOptions
  private readonly states = new Map<string, ConsoleState>()
  private readonly buckets = new Map<number, TokenBucket>()
  private readonly touchedAt = new Map<number, number>()
  private readonly backoff: readonly number[]
  private readonly minuteMs: number
  private readonly log: Logger
  private unsubscribe: (() => void) | null = null
  private stopped = false

  constructor(o: ConsoleManagerOptions) {
    this.o = o
    this.backoff = o.backoffMs ?? DEFAULT_BACKOFF
    this.minuteMs = o.minuteMs ?? 60_000
    this.log = o.log.child("serial")
  }

  private now(): Date { return this.o.now?.() ?? new Date() }

  // --- lifecycle -----------------------------------------------------------------------------------

  async start(): Promise<void> {
    this.stopped = false
    this.unsubscribe = this.o.reservations.onChange((c) => {
      try { this.onReservationChange(c) } catch (err) { this.log.error("Error al aplicar un cambio de reserva", { err }) }
    })
    for (const r of await this.loadRows({})) this.addState(r)
    for (const st of this.states.values()) if (st.row.binding) st.capture.marker(CAPTURE_MARK.serverStart)
    await Promise.all([...this.states.values()].map((st) => this.enqueue(st, () => this.evaluate(st))))
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.unsubscribe?.()
    this.unsubscribe = null
    await Promise.all([...this.states.values()].map(async (st) => {
      this.clearTimers(st)
      await Promise.race([st.queue, new Promise((r) => setTimeout(r, 2000).unref())])
      const p = st.port
      st.port = null
      st.gen++
      if (p) await p.close().catch(() => undefined)
      if (st.row.binding) st.capture.marker(CAPTURE_MARK.serverStop)
      await st.capture.flush()
    }))
  }

  /** Any discovery event resets the backoff and re-resolves every console at once (auto re-acquire, §4.5 rule 4). */
  async onDiscoveryChange(): Promise<void> {
    await Promise.all([...this.states.values()].map((st) => {
      st.backoffIdx = 0
      this.clearRetry(st)
      return this.enqueue(st, () => this.evaluate(st))
    }))
  }

  /** Capture paused/resumed: the runtime of every console changes. */
  republishAll(): void {
    for (const st of this.states.values()) this.publishStatus(st)
  }

  // --- ConsoleManager (frozen interface) ----------------------------------------------------------

  runtime(consoleId: string): ConsoleRuntimeDTO | null {
    const st = this.states.get(consoleId)
    return st ? this.runtimeOf(st) : null
  }

  runtimeForEquipment(equipmentId: string): Record<string, ConsoleRuntimeDTO> {
    const out: Record<string, ConsoleRuntimeDTO> = {}
    for (const st of this.states.values()) if (st.row.equipmentId === equipmentId) out[st.row.id] = this.runtimeOf(st)
    return out
  }

  async reloadConsole(consoleId: string): Promise<void> {
    const rows = await this.loadRows({ id: consoleId })
    const st = this.states.get(consoleId)
    if (!rows.length) {
      if (st) await this.enqueue(st, () => this.remove(st))
      return
    }
    await this.upsert(rows[0])
  }

  async reloadEquipment(equipmentId: string): Promise<void> {
    const rows = await this.loadRows({ equipmentId })
    const ids = new Set(rows.map((r) => r.id))
    for (const st of [...this.states.values()]) {
      if (st.row.equipmentId === equipmentId && !ids.has(st.row.id)) await this.enqueue(st, () => this.remove(st))
    }
    for (const r of rows) await this.upsert(r)
  }

  async release(consoleId: string, actor: Actor, untilMin: number | null): Promise<ConsoleRuntimeDTO> {
    const st = this.mustGet(consoleId)
    this.checkWrite(st, actor)
    return this.enqueue(st, async () => {
      const at = this.now()
      const until = untilMin ? new Date(at.getTime() + untilMin * this.minuteMs) : null
      const byName = actor.displayName || actor.name
      await this.o.prisma.serialConsole.update({
        where: { id: consoleId },
        data: { releasedAt: at, releasedById: actor.id, releasedByName: byName, releaseUntil: until },
      })
      Object.assign(st.row, { releasedAt: at, releasedByName: byName, releaseUntil: until })
      this.clearRetry(st)
      await this.closePort(st)
      st.capture.marker(CAPTURE_MARK.released(actor.name, until ? hhmmUtc(until) : null))
      this.setStatus(st, "released", null, null)
      this.scheduleRelease(st)
      this.o.audit.record({
        actor: plainActor(actor), action: "console.release", equipment: { id: st.row.equipmentId, name: st.row.equipmentName },
        target: { type: "console", id: st.row.id, name: st.row.key }, detail: { durationMin: untilMin, until: until?.toISOString() ?? null },
      })
      this.log.info(SERIAL_LOG.released, { consola: st.row.key, equipo: st.row.equipmentName, por: actor.name })
      return this.runtimeOf(st)
    })
  }

  async retake(consoleId: string, actor: Actor): Promise<ConsoleRuntimeDTO> {
    const st = this.mustGet(consoleId)
    this.checkWrite(st, actor)
    return this.enqueue(st, async () => {
      await this.clearRelease(st)
      st.capture.marker(CAPTURE_MARK.retaken(actor.name))
      this.o.audit.record({
        actor: plainActor(actor), action: "console.retake", equipment: { id: st.row.equipmentId, name: st.row.equipmentName },
        target: { type: "console", id: st.row.id, name: st.row.key },
      })
      this.log.info(SERIAL_LOG.retaken, { consola: st.row.key, equipo: st.row.equipmentName, por: actor.name })
      st.backoffIdx = 0
      this.clearRetry(st)
      await this.evaluate(st)
      return this.runtimeOf(st)
    })
  }

  async clearHistory(consoleId: string, actor: Actor): Promise<void> {
    const st = this.mustGet(consoleId)
    this.checkWrite(st, actor)
    st.history.clear()
    for (const s of st.sessions) s.sendJson({ t: "cleared", byName: actor.name })
    st.capture.marker(CAPTURE_MARK.cleared(actor.name))
    this.o.audit.record({
      actor: plainActor(actor), action: "console.clear", equipment: { id: st.row.equipmentId, name: st.row.equipmentName },
      target: { type: "console", id: st.row.id, name: st.row.key },
    })
  }

  async listCaptureFiles(consoleId: string, opts: { includeInput: boolean }): Promise<CaptureFileDTO[]> {
    return this.o.capture.list(consoleId, opts.includeInput)
  }

  captureFilePath(consoleId: string, fileName: string): string | null {
    return this.o.capture.filePath(consoleId, fileName)
  }

  // --- sessions (ws.ts) ----------------------------------------------------------------------------

  has(consoleId: string): boolean {
    const st = this.states.get(consoleId)
    return !!st && !st.deleted
  }

  equipmentOf(consoleId: string): { equipmentId: string; equipmentName: string; key: string } | null {
    const st = this.states.get(consoleId)
    return st ? { equipmentId: st.row.equipmentId, equipmentName: st.row.equipmentName, key: st.row.key } : null
  }

  /** hello → history (≤ 64 KiB chunks) → history-end, then live data. False when the console is gone. */
  attachSession(s: ConsoleSessionLike): boolean {
    const st = this.states.get(s.consoleId)
    if (!st || st.deleted) return false
    s.mode = this.o.reservations.isHolder(st.row.equipmentId, s.userId) ? "rw" : "ro"
    st.sessions.add(s)
    this.buckets.set(s.id, new TokenBucket(WS_LIMITS.maxInputBytesPerSec, WS_LIMITS.maxInputBytesPerSec))
    const hist = st.history.snapshot()
    s.sendJson({
      t: "hello", protocol: 1, kind: "console", consoleId: st.row.id, equipmentId: st.row.equipmentId, key: st.row.key, label: st.row.label,
      mode: s.mode, runtime: this.runtimeOf(st), line: st.row.line, enterMode: st.row.enterMode, localEcho: st.row.localEcho,
      historyBytes: hist.length, viewers: this.viewersOf(st), serverNow: this.now().toISOString(),
    })
    for (let off = 0; off < hist.length; off += WS_LIMITS.historyChunkBytes) {
      s.sendBinary(hist.subarray(off, off + WS_LIMITS.historyChunkBytes), { history: true })
    }
    s.sendJson({ t: "history-end", bytes: hist.length, truncated: st.history.truncated })
    this.scheduleViewers(st)
    return true
  }

  detachSession(s: ConsoleSessionLike): void {
    this.buckets.delete(s.id)
    this.touchedAt.delete(s.id)
    const st = this.states.get(s.consoleId)
    if (!st) return
    if (st.sessions.delete(s)) this.scheduleViewers(st)
  }

  /** Write path (§4.5): mode, holder at write time, port open, 64 KiB/s, Enter mapping, capture, touch. */
  write(s: ConsoleSessionLike, bytes: Buffer): void {
    const st = this.states.get(s.consoleId)
    if (!st || !bytes.length) return
    if (s.mode !== "rw") return s.sendJson({ t: "input-rejected", reason: "not-holder" })
    if (!this.o.reservations.isHolder(st.row.equipmentId, s.userId)) {
      s.mode = "ro"
      s.sendJson({ t: "mode", mode: "ro", reason: "expired" })
      this.scheduleViewers(st)
      return s.sendJson({ t: "input-rejected", reason: "not-holder" })
    }
    const port = st.port
    if (!port || !port.isOpen()) return s.sendJson({ t: "input-rejected", reason: "port-not-open" })
    const bucket = this.buckets.get(s.id)
    if (bucket && !bucket.take(bytes.length)) return s.sendJson({ t: "input-rejected", reason: "rate-limited" })
    port.write(mapEnter(bytes, st.row.enterMode)).catch((err: unknown) => this.log.debug("Error al escribir en la consola", { consola: st.row.key, error: String(err) }))
    st.capture.writeInput(s.username, bytes)
    const t = Date.now()
    if (t - (this.touchedAt.get(s.id) ?? 0) >= HOLDER_TOUCH_MS) {
      this.touchedAt.set(s.id, t)
      this.o.reservations.touch(st.row.equipmentId, s.userId, "console")
    }
  }

  /** BREAK from the holder only: brk on, wait, brk off. Audited. */
  async sendBreak(s: ConsoleSessionLike, ms: number): Promise<void> {
    const st = this.states.get(s.consoleId)
    if (!st) return
    if (s.mode !== "rw" || !this.o.reservations.isHolder(st.row.equipmentId, s.userId)) return s.sendJson({ t: "input-rejected", reason: "not-holder" })
    const port = st.port
    if (!port || !port.isOpen()) return s.sendJson({ t: "input-rejected", reason: "port-not-open" })
    try {
      await port.set({ brk: true })
      await new Promise((r) => setTimeout(r, Math.min(2000, Math.max(50, ms))))
      await port.set({ brk: false })
    } catch (err) {
      this.log.warn("No se pudo enviar BREAK", { consola: st.row.key, error: String(err) })
    }
    this.o.audit.record({
      actor: { kind: "user", id: s.userId, name: s.username, ip: s.ip ?? null }, action: "console.break",
      equipment: { id: st.row.equipmentId, name: st.row.equipmentName }, target: { type: "console", id: st.row.id, name: st.row.key }, detail: { ms },
    })
  }

  // --- taps (serial-over-TCP accesses) ------------------------------------------------------------

  attachTap(consoleId: string, tap: ConsoleTap, historyBytes: number): ConsoleTapHello | null {
    const st = this.states.get(consoleId)
    if (!st || st.deleted) return null
    st.taps.add(tap)
    return {
      history: historyBytes > 0 ? st.history.tail(historyBytes) : Buffer.alloc(0),
      runtime: this.runtimeOf(st), key: st.row.key, label: st.row.label, equipmentName: st.row.equipmentName,
    }
  }

  detachTap(consoleId: string, tap: ConsoleTap): void {
    this.states.get(consoleId)?.taps.delete(tap)
  }

  writeFromTap(consoleId: string, bytes: Buffer, who: string): "ok" | "port-not-open" | "missing" {
    const st = this.states.get(consoleId)
    if (!st || st.deleted) return "missing"
    if (!bytes.length) return "ok"
    const port = st.port
    if (!port || !port.isOpen()) return "port-not-open"
    port.write(bytes).catch((err: unknown) => this.log.debug("Error al escribir en la consola", { consola: st.row.key, error: String(err) }))
    st.capture.writeInput(who, bytes)
    return "ok"
  }

  // --- discovery annotations, probe and preview -------------------------------------------------------

  assignmentFor(stableKey: string): SerialPortDTO["assignment"] {
    for (const st of this.states.values()) {
      if (st.resolvedKey === stableKey) {
        return { equipmentId: st.row.equipmentId, equipmentName: st.row.equipmentName, consoleId: st.row.id, consoleKey: st.row.key, consoleLabel: st.row.label }
      }
    }
    return null
  }

  isHeldOpen(stableKey: string): boolean {
    for (const st of this.states.values()) if (st.port && st.resolvedKey === stableKey) return true
    return false
  }

  isBound(stableKey: string): boolean {
    for (const st of this.states.values()) if (st.resolvedKey === stableKey || st.row.binding?.bindingKey === stableKey) return true
    return false
  }

  /** The history tail of an open console on that device (identify classifies it instead of reopening). */
  heldHistory(stableKey: string): Buffer | null {
    for (const st of this.states.values()) if (st.port && st.resolvedKey === stableKey) return st.history.tail(8192)
    return null
  }

  stats(): { openConsoles: number; problemConsoles: number } {
    let open = 0
    let problems = 0
    for (const st of this.states.values()) {
      if (st.port) open++
      if (st.row.binding && PROBLEM.has(st.status)) problems++
    }
    return { openConsoles: open, problemConsoles: problems }
  }

  // --- internals -----------------------------------------------------------------------------------

  private mustGet(consoleId: string): ConsoleState {
    const st = this.states.get(consoleId)
    if (!st || st.deleted) throw new DomainError("NOT_FOUND", errorMessage("NOT_FOUND"))
    return st
  }

  /** §4.5 rule 8, D24: the holder; an admin only on an unreserved unit; the system actor (auto-retake) always. */
  private checkWrite(st: ConsoleState, actor: Actor): void {
    if (actor.kind === "system") return
    const reservation = this.o.reservations.get(st.row.equipmentId)
    const r = canWriteConsoleEquipment(reservation, { id: actor.id ?? "", isAdmin: actor.isAdmin })
    if (r === "NOT_HOLDER") throw new DomainError("NOT_HOLDER", errorMessage("NOT_HOLDER"))
    if (r === "RESERVED_BY_OTHER") {
      const details = { holderName: reservation?.holderName ?? "" }
      throw new DomainError("RESERVED_BY_OTHER", errorMessage("RESERVED_BY_OTHER", details), undefined, details)
    }
  }

  private enqueue<T>(st: ConsoleState, fn: () => Promise<T>): Promise<T> {
    const run = st.queue.then(fn)
    st.queue = run.then(() => undefined, (err: unknown) => {
      this.log.error("Error en la gestión de la consola", { consola: st.row.key, err })
    })
    return run
  }

  private async loadRows(where: { id?: string; equipmentId?: string }): Promise<ConsoleRow[]> {
    const rows = await this.o.prisma.serialConsole.findMany({
      where,
      include: { equipment: { select: { name: true } } },
      orderBy: [{ equipmentId: "asc" }, { position: "asc" }],
    })
    return rows.map((r) => mapRow(r))
  }

  private metaOf(row: ConsoleRow) {
    return { consoleId: row.id, equipmentId: row.equipmentId, equipmentName: row.equipmentName, key: row.key, label: row.label }
  }

  private addState(row: ConsoleRow): ConsoleState {
    const st: ConsoleState = {
      row, status: "unbound", devNode: null, detail: null, since: this.now(), port: null, openPath: null, target: null, gen: 0,
      resolvedKey: null, history: new ByteRing(this.o.config.serial.historyBytes), line: new LineTracker(), lastRxAt: null,
      sessions: new Set(), taps: new Set(), capture: this.o.capture.writer(this.metaOf(row), row.captureToDisk), backoffIdx: 0,
      retryTimer: null, releaseTimer: null, viewersTimer: null, queue: Promise.resolve(), deleted: false,
      act: { at: 0, line: null, rxAt: 0, timer: null }, lastPublished: "", lastFailure: null,
    }
    this.states.set(row.id, st)
    return st
  }

  private async upsert(row: ConsoleRow): Promise<void> {
    const existing = this.states.get(row.id)
    if (!existing) {
      const st = this.addState(row)
      await this.enqueue(st, async () => {
        if (row.binding) await this.closePreviews(st, row.binding)
        await this.evaluate(st)
      })
      return
    }
    await this.enqueue(existing, () => this.applyChange(existing, row))
  }

  private async applyChange(st: ConsoleState, row: ConsoleRow): Promise<void> {
    const old = st.row
    const lineChanged = JSON.stringify(old.line) !== JSON.stringify(row.line) || old.hupcl !== row.hupcl
    const bindingChanged = JSON.stringify(old.binding) !== JSON.stringify(row.binding) || old.bindingInvalid !== row.bindingInvalid
    const newlyBound = !!row.binding && (!old.binding || old.binding.bindingKey !== row.binding.bindingKey)
    st.row = row
    if (old.captureToDisk !== row.captureToDisk) {
      await this.o.capture.release(row.id)
      st.capture = this.o.capture.writer(this.metaOf(row), row.captureToDisk)
    } else {
      st.capture.updateMeta(this.metaOf(row))
    }
    if (newlyBound && row.binding) await this.closePreviews(st, row.binding)
    if (lineChanged || bindingChanged) {
      if (st.port) {
        await this.closePort(st)
        st.capture.marker(CAPTURE_MARK.closed)
      }
      st.backoffIdx = 0
      this.clearRetry(st)
    }
    await this.evaluate(st)
    this.publishStatus(st)
  }

  /** Newly bound: the wizard's own preview on that port must go first, so the console never starts as "busy". */
  private async closePreviews(st: ConsoleState, binding: ConsoleBindingRecord): Promise<void> {
    const r = resolveBinding(binding, this.o.discovery.devices())
    const keys = new Set([binding.bindingKey])
    if (r.status === "ok") keys.add(r.device.stableKey)
    for (const key of keys) {
      try {
        await this.o.previews.closeForStableKey(key, WS_REASON.assigned(st.row.equipmentName, st.row.key))
      } catch (err) {
        this.log.error("Error al cerrar la vista previa", { err })
      }
    }
  }

  private async remove(st: ConsoleState): Promise<void> {
    st.deleted = true
    this.clearTimers(st)
    if (st.port) {
      await this.closePort(st)
      st.capture.marker(CAPTURE_MARK.closed)
    }
    for (const s of [...st.sessions]) s.close(WS_CLOSE.CONSOLE_CHANGED, WS_REASON.consoleChanged)
    st.sessions.clear()
    for (const t of [...st.taps]) {
      try { t.onGone() } catch (err) { this.log.error("Error al cerrar un acceso de la consola", { err }) }
    }
    st.taps.clear()
    await this.o.capture.release(st.row.id)
    this.states.delete(st.row.id)
  }

  /** Decides what the port should be (§4.5 lifecycle rules 1–6) and makes it so. Runs inside the console queue. */
  private async evaluate(st: ConsoleState): Promise<void> {
    if (st.deleted || this.stopped) return
    const row = st.row
    const res = row.binding ? resolveBinding(row.binding, this.o.discovery.devices()) : null
    st.resolvedKey = res?.status === "ok" ? res.device.stableKey : null
    if (row.bindingInvalid) {
      await this.closePort(st)
      this.setStatus(st, "error", null, SERIAL_DETAIL.invalidBinding)
      return
    }
    if (!row.binding) {
      await this.closePort(st)
      this.clearRetry(st)
      this.setStatus(st, "unbound", null, null)
      return
    }
    if (row.releasedAt) {
      if (!row.releaseUntil || row.releaseUntil.getTime() > this.now().getTime()) {
        await this.closePort(st)
        this.clearRetry(st)
        this.setStatus(st, "released", null, null)
        this.scheduleRelease(st)
        return
      }
      await this.autoRetake(st)
    }
    if (!res || res.status !== "ok") {
      const detail = res?.status === "ambiguous" ? SERIAL_DETAIL.ambiguous : SERIAL_DETAIL.missing
      if (st.port) {
        await this.closePort(st)
        st.capture.marker(CAPTURE_MARK.missing(detail))
      }
      this.clearRetry(st)
      this.setStatus(st, "missing", null, detail)
      return
    }
    const dev = res.device
    if (st.port && st.port.isOpen() && st.openPath === dev.openPath && st.target === dev.target) {
      if (st.status === "open" && st.detail !== res.warning) this.setStatus(st, "open", dev.devNode, res.warning)
      return
    }
    if (st.port) {
      await this.closePort(st)
      st.capture.marker(CAPTURE_MARK.closed)
    }
    await this.open(st, dev, res.warning)
  }

  private async open(st: ConsoleState, dev: SerialDevice, warning: string | null): Promise<void> {
    this.clearRetry(st)
    this.setStatus(st, "opening", dev.devNode, null)
    const gen = ++st.gen
    let handle: PortHandle
    try {
      handle = await this.openWithTimeout(st, dev, gen)
    } catch (err) {
      if (gen !== st.gen || st.deleted || this.stopped) return
      const m = mapOpenError(err)
      if (m.kind === "busy") this.o.usage.busy.add(dev.stableKey)
      const failure = `${m.kind}:${m.message}`
      if (st.lastFailure !== failure) {
        st.lastFailure = failure
        this.log.warn(SERIAL_LOG.openFailed, { consola: st.row.key, equipo: st.row.equipmentName, dispositivo: dev.devNode, causa: m.message })
      }
      this.setStatus(st, m.kind, dev.devNode, m.detail)
      this.scheduleRetry(st)
      return
    }
    if (gen !== st.gen || st.deleted || this.stopped) {
      await handle.close().catch(() => undefined)
      return
    }
    this.o.usage.busy.delete(dev.stableKey)
    st.port = handle
    st.openPath = dev.openPath
    st.target = dev.target
    st.backoffIdx = 0
    st.lastFailure = null
    handle.onData((chunk) => this.onData(st, handle, chunk))
    handle.onClose((err) => { void this.enqueue(st, () => this.onPortLost(st, handle, err)) })
    st.capture.openMarker(dev.devNode, lineSummary(st.row.line))
    this.setStatus(st, "open", dev.devNode, warning)
    this.log.info(SERIAL_LOG.opened, { consola: st.row.key, equipo: st.row.equipmentName, dispositivo: dev.devNode, linea: lineSummary(st.row.line) })
    this.o.prisma.serialConsole.update({ where: { id: st.row.id }, data: { lastDevNode: dev.devNode, lastSeenAt: this.now() } })
      .catch(() => undefined) // deleted meanwhile: reloadConsole will notice
  }

  /**
   * A hung open (a misbehaving USB device) must not block the console queue forever: give up after 10 s and retry
   * with backoff; a handle that arrives later is closed at once.
   */
  private openWithTimeout(st: ConsoleState, dev: SerialDevice, gen: number): Promise<PortHandle> {
    return new Promise<PortHandle>((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        settled = true
        reject(new Error(OPEN_TIMEOUT_MESSAGE))
      }, this.o.openTimeoutMs ?? OPEN_TIMEOUT_MS)
      timer.unref()
      this.o.openPort({ path: dev.openPath, line: st.row.line, hupcl: st.row.hupcl }).then(
        (h) => {
          clearTimeout(timer)
          if (settled || gen !== st.gen) {
            void h.close().catch(() => undefined)
            if (!settled) reject(new Error("superseded"))
            return
          }
          settled = true
          resolve(h)
        },
        (err: unknown) => {
          clearTimeout(timer)
          if (settled) return
          settled = true
          reject(err)
        },
      )
    })
  }

  /** Unplug or I/O error while open (§4.5 rule 5): close promptly, mark missing, keep the sessions, retry. */
  private async onPortLost(st: ConsoleState, handle: PortHandle, err: Error | null): Promise<void> {
    if (st.port !== handle) return
    st.port = null
    st.gen++
    st.openPath = null
    st.target = null
    await handle.close().catch(() => undefined)
    if (st.deleted || this.stopped) return
    st.capture.marker(CAPTURE_MARK.missing(SERIAL_DETAIL.disconnected))
    this.setStatus(st, "missing", st.devNode, SERIAL_DETAIL.disconnected)
    this.log.warn(SERIAL_LOG.closedUnexpectedly, { consola: st.row.key, equipo: st.row.equipmentName, causa: err?.message ?? "cerrado" })
    st.backoffIdx = 0
    this.scheduleRetry(st)
  }

  private async closePort(st: ConsoleState): Promise<void> {
    st.gen++
    const p = st.port
    if (!p) return
    st.port = null
    st.openPath = null
    st.target = null
    await p.close().catch(() => undefined)
  }

  private async clearRelease(st: ConsoleState): Promise<void> {
    if (st.releaseTimer) clearTimeout(st.releaseTimer)
    st.releaseTimer = null
    if (!st.row.releasedAt) return
    await this.o.prisma.serialConsole.update({
      where: { id: st.row.id },
      data: { releasedAt: null, releasedById: null, releasedByName: null, releaseUntil: null },
    })
    Object.assign(st.row, { releasedAt: null, releasedByName: null, releaseUntil: null })
  }

  /** The release duration ended: clear it (DB) and audit a system retake (§4.5 rule 2). */
  private async autoRetake(st: ConsoleState): Promise<void> {
    try {
      await this.clearRelease(st)
    } catch (err) {
      this.log.error("No se pudo retomar el puerto automáticamente", { consola: st.row.key, err })
      return
    }
    st.capture.marker(CAPTURE_MARK.retaken(SYSTEM_ACTOR.name))
    this.o.audit.record({
      actor: SYSTEM_ACTOR, action: "console.retake", equipment: { id: st.row.equipmentId, name: st.row.equipmentName },
      target: { type: "console", id: st.row.id, name: st.row.key }, detail: { auto: true },
    })
    this.log.info(SERIAL_LOG.retaken, { consola: st.row.key, equipo: st.row.equipmentName, por: SYSTEM_ACTOR.name })
  }

  private scheduleRelease(st: ConsoleState): void {
    if (st.releaseTimer) clearTimeout(st.releaseTimer)
    st.releaseTimer = null
    const until = st.row.releaseUntil
    if (!until || this.stopped) return
    const delay = Math.min(2_147_000_000, Math.max(0, until.getTime() - this.now().getTime()))
    st.releaseTimer = setTimeout(() => {
      st.releaseTimer = null
      void this.enqueue(st, () => this.evaluate(st))
    }, delay)
    st.releaseTimer.unref()
  }

  private scheduleRetry(st: ConsoleState): void {
    this.clearRetry(st)
    if (st.deleted || this.stopped) return
    const delay = this.backoff[Math.min(st.backoffIdx, this.backoff.length - 1)]
    st.backoffIdx++
    st.retryTimer = setTimeout(() => {
      st.retryTimer = null
      void this.enqueue(st, () => this.evaluate(st))
    }, delay)
    st.retryTimer.unref()
  }

  private clearRetry(st: ConsoleState): void {
    if (st.retryTimer) clearTimeout(st.retryTimer)
    st.retryTimer = null
  }

  private clearTimers(st: ConsoleState): void {
    this.clearRetry(st)
    for (const t of [st.releaseTimer, st.viewersTimer, st.act.timer]) if (t) clearTimeout(t)
    st.releaseTimer = st.viewersTimer = st.act.timer = null
  }

  // --- data path -----------------------------------------------------------------------------------

  private onData(st: ConsoleState, handle: PortHandle, chunk: Buffer): void {
    if (st.port !== handle) return
    try {
      st.history.push(chunk)
      st.capture.writeRx(chunk)
      st.line.push(chunk)
      st.lastRxAt = this.now()
      for (const s of st.sessions) s.sendBinary(chunk)
      for (const t of st.taps) t.onData(chunk)
      this.maybePublishActivity(st)
    } catch (err) {
      this.log.error("Error al procesar datos de la consola", { consola: st.row.key, err })
    }
  }

  /** console.activity at most every 500 ms, when the last line changed or RX advanced > 2 s (§4.5 rule 12). */
  private maybePublishActivity(st: ConsoleState): void {
    const line = st.line.lastLine()
    const rx = st.lastRxAt?.getTime() ?? 0
    if (line === st.act.line && rx - st.act.rxAt <= 2000) return
    const t = this.now().getTime()
    const wait = 500 - (t - st.act.at)
    if (wait <= 0) {
      st.act = { at: t, line, rxAt: rx, timer: st.act.timer }
      this.o.bus.publish(
        { type: "console.activity", equipmentId: st.row.equipmentId, consoleId: st.row.id, lastLine: line, lastRxAt: new Date(rx).toISOString() },
        { kind: "equipment", equipmentId: st.row.equipmentId },
      )
      return
    }
    if (st.act.timer) return
    st.act.timer = setTimeout(() => {
      st.act.timer = null
      if (!st.deleted) this.maybePublishActivity(st)
    }, wait)
    st.act.timer.unref()
  }

  // --- status and presence -------------------------------------------------------------------------

  private viewersOf(st: ConsoleState): ViewerPresenceDTO[] {
    const by = new Map<string, ViewerPresenceDTO>()
    for (const s of st.sessions) {
      const prev = by.get(s.userId)
      if (!prev || (prev.mode === "ro" && s.mode === "rw")) by.set(s.userId, { userId: s.userId, name: s.name, mode: s.mode })
    }
    return [...by.values()].sort((a, b) => a.name.localeCompare(b.name, "es"))
  }

  private runtimeOf(st: ConsoleState): ConsoleRuntimeDTO {
    const r = st.row
    return {
      status: st.status,
      devNode: st.devNode,
      detail: st.detail,
      since: st.since.toISOString(),
      lastRxAt: st.lastRxAt?.toISOString() ?? null,
      lastLine: st.line.lastLine(),
      viewers: new Set([...st.sessions].map((s) => s.userId)).size,
      released: r.releasedAt ? { byName: r.releasedByName ?? "", at: r.releasedAt.toISOString(), until: r.releaseUntil?.toISOString() ?? null } : null,
      capture: this.o.capture.consoleState(r.captureToDisk),
    }
  }

  private setStatus(st: ConsoleState, status: ConsoleStatus, devNode: string | null, detail: string | null): void {
    if (st.status !== status) st.since = this.now()
    st.status = status
    st.devNode = devNode
    st.detail = detail
    this.publishStatus(st)
  }

  /** console.status to SSE (audience equipment) and {t:"status"} to the sessions, only when something changed. */
  private publishStatus(st: ConsoleState): void {
    if (st.deleted) return
    const runtime = this.runtimeOf(st)
    const key = JSON.stringify({ ...runtime, lastLine: null, lastRxAt: null })
    if (key === st.lastPublished) return
    st.lastPublished = key
    this.o.bus.publish({ type: "console.status", equipmentId: st.row.equipmentId, consoleId: st.row.id, runtime }, { kind: "equipment", equipmentId: st.row.equipmentId })
    for (const s of st.sessions) s.sendJson({ t: "status", runtime })
    for (const t of st.taps) t.onStatus(runtime)
  }

  /** Presence and the viewer count, debounced to 1 s (§4.5 rule 11). */
  private scheduleViewers(st: ConsoleState): void {
    if (st.viewersTimer || st.deleted) return
    st.viewersTimer = setTimeout(() => {
      st.viewersTimer = null
      if (st.deleted) return
      const viewers = this.viewersOf(st)
      for (const s of st.sessions) s.sendJson({ t: "viewers", viewers })
      this.publishStatus(st)
    }, 1000)
    st.viewersTimer.unref()
  }

  private onReservationChange(c: ReservationChange): void {
    for (const st of this.states.values()) {
      if (st.row.equipmentId !== c.equipmentId) continue
      let changed = false
      for (const s of st.sessions) {
        const rw = c.after?.holderId === s.userId
        const mode: WsMode = rw ? "rw" : "ro"
        if (mode !== s.mode) {
          s.mode = mode
          changed = true
          s.sendJson({ t: "mode", mode, reason: rw ? "reserved" : modeReason(c.cause) })
        } else if (!rw && c.cause === "reserve" && c.after && c.before?.holderId !== c.after.holderId) {
          s.sendJson({ t: "mode", mode: "ro", reason: "reserved-by-other" })
        }
      }
      if (changed) this.scheduleViewers(st)
    }
  }
}
