// TCP forward of one Ethernet access: <bind>:<port> → <targetHost>:<targetPort>. Bidirectional with backpressure (pipe),
// half-close (allowHalfOpen on both sides), a connect timeout and a per-access connection cap.
import net from "node:net"
import type { AccessConnectionDTO } from "@/lib/contracts/accesses"
import { closeServer, ConnectionTable, listenOn, remoteOf } from "./listener"

export type ForwardEvent =
  | { kind: "connect"; remote: string }
  | { kind: "close"; remote: string; rxBytes: number; txBytes: number; ms: number }
  | { kind: "refused"; remote: string; reason: "max-connections" }
  | { kind: "target-error"; remote: string; error: string }

export interface ForwardOptions {
  bind: string
  port: number
  target: { host: string; port: number }
  /** Source address for the connections to the target ("Red de equipos": the server's address in the port's VLAN,
   * so policy routing sends them out of that VLAN interface). */
  localAddress?: string | null
  /**
   * The error reported when `localAddress` is not an address of the server any more (EADDRNOTAVAIL): the connection
   * fails with this text instead of ever leaving from another address (and by another interface).
   */
  bindError?: string
  maxConnections: number
  connectTimeoutMs?: number
  onEvent: (e: ForwardEvent) => void
  /** Client → target data (renews the reservation, throttled by the caller). */
  onActivity?: () => void
}

export class TcpForward {
  private readonly o: ForwardOptions
  private readonly server: net.Server
  private readonly table = new ConnectionTable()

  constructor(o: ForwardOptions) {
    this.o = o
    this.server = net.createServer({ allowHalfOpen: true, pauseOnConnect: true }, (c) => this.accept(c))
    this.server.on("error", () => { /* listen errors are handled by listen(); later ones are not fatal */ })
  }

  listen(): Promise<number> {
    return listenOn(this.server, this.o.port, this.o.bind)
  }

  connections(): AccessConnectionDTO[] {
    return this.table.list()
  }

  /** Stops listening and drops every connection. */
  async close(): Promise<void> {
    this.table.destroyAll()
    await closeServer(this.server)
  }

  private accept(client: net.Socket): void {
    const remote = remoteOf(client)
    if (this.table.size >= this.o.maxConnections) {
      this.o.onEvent({ kind: "refused", remote, reason: "max-connections" })
      client.destroy()
      return
    }
    const t0 = Date.now()
    const tracked = this.table.add(client)
    client.setKeepAlive(true, 30_000)
    client.setNoDelay(true)
    const upstream = net.connect({ host: this.o.target.host, port: this.o.target.port, allowHalfOpen: true, ...(this.o.localAddress ? { localAddress: this.o.localAddress } : {}) })
    tracked.extra = upstream
    let connected = false
    let closed = false
    const timer = setTimeout(() => upstream.destroy(new Error("tiempo de conexión agotado")), this.o.connectTimeoutMs ?? 5000)
    timer.unref()
    const finish = () => {
      if (closed) return
      closed = true
      clearTimeout(timer)
      this.table.remove(tracked.id)
      client.destroy()
      upstream.destroy()
      if (connected) this.o.onEvent({ kind: "close", remote, rxBytes: client.bytesRead, txBytes: client.bytesWritten, ms: Date.now() - t0 })
    }
    upstream.once("connect", () => {
      clearTimeout(timer)
      connected = true
      upstream.setNoDelay(true)
      upstream.setKeepAlive(true, 30_000)
      this.o.onEvent({ kind: "connect", remote })
      if (this.o.onActivity) client.on("data", () => this.o.onActivity?.())
      client.pipe(upstream)
      upstream.pipe(client)
      client.resume()
    })
    upstream.once("error", (err: NodeJS.ErrnoException) => {
      if (!connected) this.o.onEvent({ kind: "target-error", remote, error: isBindError(err, this.o.localAddress) && this.o.bindError ? this.o.bindError : err.message })
      finish()
    })
    client.once("error", finish)
    // Both halves closed (FIN each way, or a reset) → done.
    let ends = 0
    const onEnd = () => { if (++ends === 2) finish() }
    client.once("end", onEnd)
    upstream.once("end", onEnd)
    client.once("close", finish)
    upstream.once("close", () => { if (connected) finish() })
  }
}

/** The source address is not on the server (bind failed): never retried from another address. */
export function isBindError(err: NodeJS.ErrnoException, localAddress: string | null | undefined): boolean {
  return !!localAddress && (err.code === "EADDRNOTAVAIL" || (err.syscall === "bind" && err.code === "EINVAL"))
}

/** Is the target reachable now? (TCP connect with a short timeout; the connection is closed at once.) */
export function probeTarget(host: string, port: number, timeoutMs = 2000, localAddress: string | null = null): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host, port, ...(localAddress ? { localAddress } : {}) })
    const done = (ok: boolean) => {
      s.removeAllListeners()
      s.destroy()
      resolve(ok)
    }
    s.setTimeout(timeoutMs, () => done(false))
    s.once("connect", () => done(true))
    s.once("error", () => done(false))
  })
}
