// Serial console over raw TCP (one per serial access): every client gets a notice, the recent history and then the live
// bytes of the SAME console the web shows (the console manager's open port, never a second open of the tty). Input is
// written as-is only while the access is writable (the equipment is reserved), and goes to the capture markers.
import net from "node:net"
import type { AccessConnectionDTO } from "@/lib/contracts/accesses"
import type { ConsoleRuntimeDTO } from "@/lib/contracts/serial"
import { accessNotice } from "@/lib/i18n/accesses"
import type { ConsoleManager, ConsoleTap } from "@/server/runtime/types"
import { TokenBucket } from "@/server/serial/pure/token-bucket"
import { closeServer, ConnectionTable, listenOn, remoteOf } from "./listener"

export type BridgeEvent =
  | { kind: "connect"; remote: string }
  | { kind: "close"; remote: string; rxBytes: number; txBytes: number; ms: number }
  | { kind: "refused"; remote: string; reason: "max-connections" | "console-missing" }

export interface SerialBridgeOptions {
  bind: string
  port: number
  consoleId: string
  source: Pick<ConsoleManager, "attachTap" | "detachTap" | "writeFromTap">
  maxConnections: number
  /** May clients write now? (the equipment is reserved) */
  writable: () => boolean
  /** Called on accepted input (renews the reservation, throttled by the reservation service). */
  onInput: () => void
  onEvent: (e: BridgeEvent) => void
  historyBytes?: number
}

const SLOW_CLIENT_BYTES = 4 * 1024 * 1024
const INPUT_BYTES_PER_SEC = 65_536
const NOTICE_EVERY_MS = 5000
const OPEN: ReadonlySet<ConsoleRuntimeDTO["status"]> = new Set(["open"])

const line = (text: string) => Buffer.from(`\r\n*** ${text} ***\r\n`, "utf8")

export class SerialBridge {
  private readonly o: SerialBridgeOptions
  private readonly server: net.Server
  private readonly table = new ConnectionTable()
  private readonly clients = new Map<string, { socket: net.Socket; tap: ConsoleTap; wasOpen: boolean; lastNotice: number; closeNotice: string | null }>()
  private writableNow = false

  constructor(o: SerialBridgeOptions) {
    this.o = o
    this.server = net.createServer((c) => this.accept(c))
    this.server.on("error", () => { /* listen errors are handled by listen() */ })
  }

  listen(): Promise<number> {
    this.writableNow = this.o.writable()
    return listenOn(this.server, this.o.port, this.o.bind)
  }

  connections(): AccessConnectionDTO[] {
    return this.table.list()
  }

  /** The reservation changed: tell every client whether it can write now. */
  writableChanged(): void {
    const w = this.o.writable()
    if (w === this.writableNow) return
    this.writableNow = w
    for (const c of this.clients.values()) c.socket.write(line(w ? accessNotice.nowWritable : accessNotice.nowReadOnly))
  }

  /** Closes every connection with a notice (the listener stays). */
  async dropAll(reason: string): Promise<void> {
    const waits: Array<Promise<void>> = []
    for (const [id, c] of this.clients) {
      waits.push(new Promise((r) => c.socket.once("close", () => r())))
      c.closeNotice = reason
      c.socket.end(line(reason))
      setTimeout(() => c.socket.destroy(), 500).unref()
      this.clients.delete(id)
      this.o.source.detachTap(this.o.consoleId, c.tap)
    }
    await Promise.all(waits)
  }

  async close(reason?: string): Promise<void> {
    if (reason) await this.dropAll(reason)
    for (const c of this.clients.values()) this.o.source.detachTap(this.o.consoleId, c.tap)
    this.clients.clear()
    this.table.destroyAll()
    await closeServer(this.server)
  }

  private accept(socket: net.Socket): void {
    const remote = remoteOf(socket)
    if (this.table.size >= this.o.maxConnections) {
      this.o.onEvent({ kind: "refused", remote, reason: "max-connections" })
      socket.end(line(accessNotice.tooMany(this.o.maxConnections)))
      setTimeout(() => socket.destroy(), 500).unref()
      return
    }
    const t0 = Date.now()
    const tracked = this.table.add(socket)
    const bucket = new TokenBucket(INPUT_BYTES_PER_SEC, INPUT_BYTES_PER_SEC)
    const who = `tcp ${remote.replace(/:\d+$/, "").replace(/^\[|\]$/g, "")}`
    socket.setNoDelay(true)
    socket.setKeepAlive(true, 30_000)
    const send = (b: Buffer) => {
      if (socket.destroyed) return
      if (socket.writableLength > SLOW_CLIENT_BYTES) {
        socket.destroy()
        return
      }
      socket.write(b)
    }
    const entry = { socket, tap: null as unknown as ConsoleTap, wasOpen: false, lastNotice: 0, closeNotice: null as string | null }
    const tap: ConsoleTap = {
      onData: (chunk) => send(chunk),
      onStatus: (rt) => {
        const open = OPEN.has(rt.status)
        if (open === entry.wasOpen) return
        entry.wasOpen = open
        send(line(open ? accessNotice.consoleOpen : rt.released ? accessNotice.released(rt.released.byName) : accessNotice.consoleClosed(rt.detail)))
      },
      onGone: () => {
        this.clients.delete(tracked.id)
        socket.end(line(accessNotice.consoleGone))
        setTimeout(() => socket.destroy(), 500).unref()
      },
    }
    entry.tap = tap
    const hello = this.o.source.attachTap(this.o.consoleId, tap, this.o.historyBytes ?? 65_536)
    if (!hello) {
      this.table.remove(tracked.id)
      this.o.onEvent({ kind: "refused", remote, reason: "console-missing" })
      socket.end(line(accessNotice.consoleGone))
      setTimeout(() => socket.destroy(), 500).unref()
      return
    }
    this.clients.set(tracked.id, entry)
    entry.wasOpen = OPEN.has(hello.runtime.status)
    const w = this.o.writable()
    send(line(accessNotice.hello(hello.equipmentName, hello.label, hello.key, w)))
    if (hello.history.length) send(hello.history)
    if (!entry.wasOpen) send(line(hello.runtime.released ? accessNotice.released(hello.runtime.released.byName) : accessNotice.consoleClosed(hello.runtime.detail)))
    this.o.onEvent({ kind: "connect", remote })

    socket.on("data", (bytes: Buffer) => {
      const now = Date.now()
      const notice = (text: string) => {
        if (now - entry.lastNotice < NOTICE_EVERY_MS) return
        entry.lastNotice = now
        send(line(text))
      }
      if (!this.o.writable()) return notice(accessNotice.readOnly)
      if (!bucket.take(bytes.length)) return notice(accessNotice.rateLimited)
      const r = this.o.source.writeFromTap(this.o.consoleId, bytes, who)
      if (r === "port-not-open") return notice(accessNotice.notOpen)
      if (r === "ok") this.o.onInput()
    })
    const finish = () => {
      if (!this.table.all().some((t) => t.id === tracked.id)) return
      this.table.remove(tracked.id)
      this.clients.delete(tracked.id)
      this.o.source.detachTap(this.o.consoleId, tap)
      this.o.onEvent({ kind: "close", remote, rxBytes: socket.bytesRead, txBytes: socket.bytesWritten, ms: Date.now() - t0 })
    }
    socket.on("error", () => socket.destroy())
    socket.once("close", finish)
  }
}
