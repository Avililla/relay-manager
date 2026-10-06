// TCP transport for relay boards (§4.8): short-lived connections (the controller mutex serialises them per board),
// request/until with a per-request timeout, receive buffer capped at 64 KiB (excess → protocol error).
import net from "node:net"
import { RELAY_TEXT } from "@/lib/i18n/relays"
import { abortError } from "./abort"
import { RelayDriverError, type TcpConnectOptions, type TcpConversation, type TcpRequestOptions } from "../types"

export const TCP_MAX_BYTES = 64 * 1024

function codeOf(e: unknown): string {
  return typeof e === "object" && e !== null && typeof (e as { code?: unknown }).code === "string" ? (e as { code: string }).code : "ERROR"
}

export function tcpConnect(o: TcpConnectOptions): Promise<TcpConversation> {
  const max = o.maxBytes ?? TCP_MAX_BYTES
  return new Promise<TcpConversation>((resolve, reject) => {
    if (o.signal?.aborted) { reject(abortError(o.signal, o.host)); return }
    const sock = net.connect({ host: o.host, port: o.port })
    sock.setNoDelay(true)
    let connected = false
    let closed = false
    let buf = Buffer.alloc(0)
    let pending: { check: () => void; fail: (e: RelayDriverError) => void } | null = null
    let failure: RelayDriverError | null = null

    const failAll = (e: RelayDriverError) => {
      if (!failure) failure = e
      if (pending) { const p = pending; pending = null; p.fail(e) }
    }
    const onAbort = () => { failAll(abortError(o.signal, o.host)); sock.destroy() }
    o.signal?.addEventListener("abort", onAbort, { once: true })
    const connectTimer = setTimeout(() => {
      if (!connected) { sock.destroy(); reject(new RelayDriverError(RELAY_TEXT.errTimeout(o.host), "timeout")) }
    }, o.timeoutMs)

    sock.on("data", (d: Buffer) => {
      if (buf.length + d.length > max) {
        failAll(new RelayDriverError(RELAY_TEXT.errTooLarge, "protocol"))
        sock.destroy()
        return
      }
      buf = Buffer.concat([buf, d])
      pending?.check()
    })
    sock.on("error", (e) => {
      if (!connected) {
        clearTimeout(connectTimer)
        reject(new RelayDriverError(RELAY_TEXT.errUnreachable(o.host, o.port, codeOf(e)), "unreachable"))
        return
      }
      failAll(new RelayDriverError(RELAY_TEXT.errUnreachable(o.host, o.port, codeOf(e)), "unreachable"))
    })
    sock.on("close", () => {
      closed = true
      o.signal?.removeEventListener("abort", onAbort)
      pending?.check()
      failAll(new RelayDriverError(RELAY_TEXT.errClosed, "protocol"))
    })
    sock.once("connect", () => {
      connected = true
      clearTimeout(connectTimer)
      resolve({
        host: o.host,
        port: o.port,
        close: () => { sock.destroy() },
        request(data: Uint8Array, until: (b: Buffer) => boolean, ro: TcpRequestOptions = {}): Promise<Buffer> {
          if (failure) return Promise.reject(failure)
          if (closed) return Promise.reject(new RelayDriverError(RELAY_TEXT.errClosed, "protocol"))
          if (pending) return Promise.reject(new RelayDriverError("Petición TCP concurrente", "protocol"))
          buf = Buffer.alloc(0) // stale bytes from a previous reply are discarded
          const timeoutMs = ro.timeoutMs ?? o.timeoutMs
          return new Promise<Buffer>((res, rej) => {
            let idleTimer: NodeJS.Timeout | null = null
            const finish = (fn: () => void) => {
              clearTimeout(timer)
              if (idleTimer) clearTimeout(idleTimer)
              pending = null
              fn()
            }
            const timer = setTimeout(() => {
              if (ro.idleMs !== undefined && buf.length > 0) finish(() => res(buf))
              else finish(() => rej(new RelayDriverError(RELAY_TEXT.errTimeout(o.host), "timeout")))
            }, timeoutMs)
            pending = {
              check: () => {
                if (buf.length > 0 && until(buf)) { finish(() => res(buf)); return }
                if (ro.idleMs !== undefined && buf.length > 0) {
                  if (idleTimer) clearTimeout(idleTimer)
                  idleTimer = setTimeout(() => finish(() => res(buf)), ro.idleMs)
                }
                if (closed && buf.length > 0 && ro.idleMs !== undefined) finish(() => res(buf))
              },
              fail: (e) => finish(() => rej(e)),
            }
            sock.write(Buffer.from(data))
          })
        },
      })
    })
  })
}

/** One request on a fresh connection, then close. */
export async function tcpRequest(o: TcpConnectOptions & { data: Uint8Array; until: (b: Buffer) => boolean } & TcpRequestOptions): Promise<Buffer> {
  const c = await tcpConnect(o)
  try {
    return await c.request(o.data, o.until, { timeoutMs: o.timeoutMs, idleMs: o.idleMs })
  } finally {
    c.close()
  }
}

/** Connect-only reachability (scan step 1). Never throws. */
export function tcpProbe(o: { host: string; port: number; timeoutMs: number; signal?: AbortSignal }): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    if (o.signal?.aborted) { resolve(false); return }
    const sock = net.connect({ host: o.host, port: o.port })
    let settled = false
    const done = (v: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      o.signal?.removeEventListener("abort", onAbort)
      sock.destroy()
      resolve(v)
    }
    const onAbort = () => done(false)
    o.signal?.addEventListener("abort", onAbort, { once: true })
    const timer = setTimeout(() => done(false), o.timeoutMs)
    sock.once("connect", () => done(true))
    sock.once("error", () => done(false))
  })
}
