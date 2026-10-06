// UDP helpers for relay discovery (§4.10): socket binding on the Discoverer port, bounded intake.
import dgram from "node:dgram"

export type UdpSocketFactory = (type: "udp4") => dgram.Socket

/** reuseAddr: the vendor Finder, simulators and this server can share port 30303 (broadcasts reach every socket). */
export const defaultUdpFactory: UdpSocketFactory = (type) => dgram.createSocket({ type, reuseAddr: true })

/** Binds 0.0.0.0:<port> with broadcast enabled. Rejects with the bind error (e.g. EADDRINUSE, EACCES). */
export function bindUdp(factory: UdpSocketFactory, port: number): Promise<dgram.Socket> {
  return new Promise<dgram.Socket>((resolve, reject) => {
    const s = factory("udp4")
    const onError = (e: Error) => { try { s.close() } catch { /* already closed */ } reject(e) }
    s.once("error", onError)
    s.bind(port, "0.0.0.0", () => {
      s.off("error", onError)
      try { s.setBroadcast(true) } catch { /* not fatal */ }
      resolve(s)
    })
  })
}

/** Sends one datagram; resolves with the error (never rejects), so send errors become warnings. */
export function sendDatagram(s: dgram.Socket, msg: Buffer, port: number, address: string): Promise<NodeJS.ErrnoException | null> {
  return new Promise((resolve) => {
    try {
      s.send(msg, port, address, (err) => resolve(err ?? null))
    } catch (e) {
      resolve(e instanceof Error ? (e as NodeJS.ErrnoException) : new Error(String(e)))
    }
  })
}

export function closeUdp(s: dgram.Socket): Promise<void> {
  return new Promise((resolve) => {
    try { s.close(() => resolve()) } catch { resolve() }
  })
}

/** At most `maxPerSec` datagrams per 1 s window; remembers when it last dropped (health "Tráfico UDP 30303 excesivo"). */
export function createRateLimiter(maxPerSec: number, now: () => Date) {
  let windowStart = 0
  let count = 0
  let lastExceeded = -Infinity
  return {
    allow(): boolean {
      const t = now().getTime()
      if (t - windowStart >= 1000) { windowStart = t; count = 0 }
      if (count >= maxPerSec) { lastExceeded = t; return false }
      count++
      return true
    },
    exceededWithin(ms: number): boolean {
      return now().getTime() - lastExceeded < ms
    },
  }
}
