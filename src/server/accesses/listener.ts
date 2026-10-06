// Shared bits of the access listeners (serial bridge and TCP forward): listening with a clear "port busy" error and a
// table of the open connections (remote address, since, bytes).
import net from "node:net"
import type { AccessConnectionDTO } from "@/lib/contracts/accesses"

export class PortBusyError extends Error {
  readonly port: number
  constructor(port: number) {
    super(`El puerto ${port} ya lo usa otro programa`)
    this.name = "PortBusyError"
    this.port = port
  }
}

/** listen() as a promise; EADDRINUSE/EACCES become PortBusyError. */
export function listenOn(server: net.Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      server.removeListener("listening", onListening)
      reject(err.code === "EADDRINUSE" || err.code === "EACCES" ? new PortBusyError(port) : err)
    }
    const onListening = () => {
      server.removeListener("error", onError)
      resolve((server.address() as net.AddressInfo).port)
    }
    server.once("error", onError)
    server.once("listening", onListening)
    server.listen({ port, host, exclusive: true })
  })
}

export function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) return resolve()
    server.close(() => resolve())
  })
}

/** "192.0.2.20:51234" ("[fe80::1]:51234" for IPv6; IPv4-mapped addresses without the ::ffff: prefix). */
export function remoteOf(s: net.Socket): string {
  const addr = (s.remoteAddress ?? "?").replace(/^::ffff:/, "")
  return addr.includes(":") ? `[${addr}]:${s.remotePort ?? 0}` : `${addr}:${s.remotePort ?? 0}`
}

interface Tracked { id: string; socket: net.Socket; remote: string; since: Date; extra?: net.Socket }

export class ConnectionTable {
  private readonly items = new Map<string, Tracked>()
  private seq = 0

  add(socket: net.Socket, now = new Date()): Tracked {
    const t: Tracked = { id: String(++this.seq), socket, remote: remoteOf(socket), since: now }
    this.items.set(t.id, t)
    return t
  }
  remove(id: string): void { this.items.delete(id) }
  get size(): number { return this.items.size }
  all(): Tracked[] { return [...this.items.values()] }
  list(): AccessConnectionDTO[] {
    return this.all().map((t) => ({
      id: t.id, remote: t.remote, since: t.since.toISOString(), rxBytes: t.socket.bytesRead, txBytes: t.socket.bytesWritten,
    }))
  }
  destroyAll(): void {
    for (const t of this.items.values()) {
      t.socket.destroy()
      t.extra?.destroy()
    }
    this.items.clear()
  }
}
