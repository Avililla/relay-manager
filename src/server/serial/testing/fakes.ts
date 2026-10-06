// Test doubles for the serial services (used only by *.test.ts under src/server/serial).
import type { ReservationCause, ReservationDTO } from "@/lib/contracts/reservations"
import type { WsServerMsg } from "@/lib/contracts/ws"
import type { AuthUser, ReservationChange, ReservationService } from "@/server/runtime/types"
import type { SerialDevice } from "../enumerate"
import type { PortHandle, PortOpenOptions, PortOpener } from "../port-factory"

/** A PortHandle whose data, loss and writes the test controls. */
export class FakePort implements PortHandle {
  readonly path: string
  readonly opts: PortOpenOptions
  readonly writes: Buffer[] = []
  readonly sets: Array<{ brk?: boolean }> = []
  closed = false
  private dataCb: ((b: Buffer) => void) | null = null
  private closeCb: ((e: Error | null) => void) | null = null

  constructor(opts: PortOpenOptions) {
    this.path = opts.path
    this.opts = opts
  }
  isOpen(): boolean { return !this.closed }
  onData(cb: (b: Buffer) => void): void { this.dataCb = cb }
  onClose(cb: (e: Error | null) => void): void { this.closeCb = cb }
  async write(data: Buffer): Promise<void> {
    if (this.closed) throw new Error("Port is not open")
    this.writes.push(Buffer.from(data))
  }
  async set(flags: { brk?: boolean }): Promise<void> { this.sets.push({ ...flags }) }
  async close(): Promise<void> { this.closed = true }
  /** Bytes from the device. */
  emit(data: string | Buffer): void { this.dataCb?.(typeof data === "string" ? Buffer.from(data) : data) }
  /** Unplug: the port goes away under us. */
  lose(err: Error = Object.assign(new Error("bad file descriptor"), { disconnected: true })): void {
    this.closed = true
    this.closeCb?.(err)
  }
  written(): string { return Buffer.concat(this.writes).toString("latin1") }
}

export interface FakeOpener {
  open: PortOpener
  ports: FakePort[]
  attempts: string[]
  /** path → error thrown on open */
  fail: Map<string, Error>
  last(path: string): FakePort | undefined
}

export function fakeOpener(): FakeOpener {
  const o: FakeOpener = {
    ports: [],
    attempts: [],
    fail: new Map(),
    open: async (opts) => {
      o.attempts.push(opts.path)
      const err = o.fail.get(opts.path)
      if (err) throw err
      const p = new FakePort(opts)
      o.ports.push(p)
      return p
    },
    last: (path) => [...o.ports].reverse().find((p) => p.path === path),
  }
  return o
}

export function virtualDevice(name: string, dir = "/run/relay-manager/sim", target = `/dev/pts/${name.replace(/\D/g, "") || "0"}`): SerialDevice {
  const devNode = `${dir}/${name}`
  return {
    name, devNode, openPath: devNode, kind: "virtual", driver: null, usb: null, byId: [], byPath: [],
    stableKey: `virtual:${devNode}`, accessible: true, accessError: null, hints: ["simulated"], target,
  }
}

export class FakeDiscovery {
  list: SerialDevice[]
  constructor(list: SerialDevice[] = []) { this.list = list }
  devices(): SerialDevice[] { return this.list }
  find(key: string): SerialDevice | null { return this.list.find((d) => d.stableKey === key) ?? null }
}

/** ReservationService with working onChange, for mode switches. */
export class TestReservations implements ReservationService {
  readonly holders = new Map<string, { id: string; name: string }>()
  readonly touches: Array<{ equipmentId: string; userId: string }> = []
  private readonly listeners = new Set<(c: ReservationChange) => void>()

  dto(equipmentId: string): ReservationDTO | null {
    const h = this.holders.get(equipmentId)
    if (!h) return null
    const now = Date.now()
    return { equipmentId, holderId: h.id, holderName: h.name, holderUsername: h.name, reservedAt: new Date(now).toISOString(), expiresAt: new Date(now + 30 * 60_000).toISOString(), note: null }
  }
  /** Changes the holder and notifies like the real service. */
  set(equipmentId: string, holder: { id: string; name: string } | null, cause: ReservationCause): void {
    const before = this.dto(equipmentId)
    if (holder) this.holders.set(equipmentId, holder)
    else this.holders.delete(equipmentId)
    const change: ReservationChange = { equipmentId, before, after: this.dto(equipmentId), cause, by: { kind: "user", id: holder?.id ?? null, name: holder?.name ?? "x" } }
    for (const l of [...this.listeners]) l(change)
  }
  async start(): Promise<void> {}
  stop(): void {}
  get(equipmentId: string): ReservationDTO | null { return this.dto(equipmentId) }
  list(): ReservationDTO[] { return [...this.holders.keys()].flatMap((id) => { const d = this.dto(id); return d ? [d] : [] }) }
  isHolder(equipmentId: string, userId: string): boolean { return this.holders.get(equipmentId)?.id === userId }
  async reserve(equipmentId: string, user: AuthUser): Promise<ReservationDTO> {
    this.set(equipmentId, { id: user.id, name: user.name }, "reserve")
    return this.dto(equipmentId) as ReservationDTO
  }
  async renew(equipmentId: string): Promise<ReservationDTO> { return this.dto(equipmentId) as ReservationDTO }
  touch(equipmentId: string, userId: string): void { this.touches.push({ equipmentId, userId }) }
  async release(equipmentId: string): Promise<void> { this.set(equipmentId, null, "release") }
  async forceRelease(equipmentId: string): Promise<void> { this.set(equipmentId, null, "force-release") }
  async releaseAllForUser(): Promise<number> { return 0 }
  onChange(listener: (c: ReservationChange) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
}

/** A console session double that records what it is sent. */
export class RecordingSession {
  static seq = 0
  readonly id = ++RecordingSession.seq
  readonly messages: WsServerMsg[] = []
  readonly binary: Buffer[] = []
  readonly order: Array<"json" | "binary"> = []
  closedWith: { code: number; reason: string } | null = null
  mode: "ro" | "rw" = "ro"
  bytesIn = 0
  bytesOut = 0
  constructor(readonly consoleId: string, readonly userId: string, readonly name: string, readonly username = name, readonly isAdmin = false) {}
  sendJson(m: WsServerMsg): void { this.messages.push(m); this.order.push("json") }
  sendBinary(b: Buffer): void { this.binary.push(Buffer.from(b)); this.order.push("binary"); this.bytesOut += b.length }
  close(code: number, reason: string): void { this.closedWith ??= { code, reason } }
  of<T extends WsServerMsg["t"]>(t: T): Array<Extract<WsServerMsg, { t: T }>> {
    return this.messages.filter((m): m is Extract<WsServerMsg, { t: T }> => m.t === t)
  }
  text(): string { return Buffer.concat(this.binary).toString("latin1") }
}
