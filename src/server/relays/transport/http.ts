// HTTP transport for relay boards (§4.8): node:http, agent:false, Connection: close, per-request timeout,
// never follows redirects, body capped at 64 KiB, Basic auth only as a header.
import http from "node:http"
import { RELAY_TEXT } from "@/lib/i18n/relays"
import { abortError } from "./abort"
import { RelayDriverError, type HttpGetOptions, type HttpResponse } from "../types"

export const HTTP_MAX_BYTES = 64 * 1024
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/
const HOSTNAME = /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/

/** Builds the URL with new URL() from a validated host and port; the path must be absolute ("/…"). */
export function boardUrl(host: string, port: number, path: string): URL {
  if (!(IPV4.test(host) || HOSTNAME.test(host)) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new RelayDriverError(RELAY_TEXT.errBadHost, "config")
  }
  if (!path.startsWith("/") || path.startsWith("//")) throw new RelayDriverError(RELAY_TEXT.errBadHost, "config")
  const url = new URL(path, `http://${host}:${port}`)
  if (url.username || url.password || url.hostname !== host.toLowerCase()) throw new RelayDriverError(RELAY_TEXT.errBadHost, "config")
  return url
}

function netError(e: unknown, host: string, port: number): RelayDriverError {
  const code = typeof e === "object" && e !== null && typeof (e as { code?: unknown }).code === "string" ? (e as { code: string }).code : "ERROR"
  if (code === "ETIMEDOUT") return new RelayDriverError(RELAY_TEXT.errTimeout(host), "timeout")
  return new RelayDriverError(RELAY_TEXT.errUnreachable(host, port, code), "unreachable")
}

export async function httpGet(o: HttpGetOptions): Promise<HttpResponse> {
  const url = boardUrl(o.host, o.port, o.path)
  const max = o.maxBytes ?? HTTP_MAX_BYTES
  const headers: Record<string, string> = { Connection: "close", "User-Agent": "relay-manager" }
  if (o.auth) headers.Authorization = `Basic ${Buffer.from(`${o.auth.username}:${o.auth.password}`, "utf8").toString("base64")}`
  return new Promise<HttpResponse>((resolve, reject) => {
    if (o.signal?.aborted) { reject(abortError(o.signal, o.host)); return }
    let settled = false
    const done = (fn: () => void) => { if (!settled) { settled = true; cleanup(); fn() } }
    const req = http.request(url, { method: "GET", agent: false, headers })
    const timer = setTimeout(() => { done(() => reject(new RelayDriverError(RELAY_TEXT.errTimeout(o.host), "timeout"))); req.destroy() }, o.timeoutMs)
    const onAbort = () => { done(() => reject(abortError(o.signal, o.host))); req.destroy() }
    o.signal?.addEventListener("abort", onAbort, { once: true })
    const cleanup = () => { clearTimeout(timer); o.signal?.removeEventListener("abort", onAbort) }
    req.on("error", (e) => done(() => reject(netError(e, o.host, o.port))))
    req.on("response", (res) => {
      const chunks: Buffer[] = []
      let size = 0
      let truncated = false
      const finish = () => done(() => resolve({
        status: res.statusCode ?? 0,
        headers: Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : v])),
        body: Buffer.concat(chunks).toString("latin1"),
        truncated,
      }))
      res.on("data", (c: Buffer) => {
        if (truncated) return
        const room = max - size
        if (c.length > room) { chunks.push(c.subarray(0, room)); size = max; truncated = true; finish(); res.destroy(); return }
        chunks.push(c)
        size += c.length
      })
      res.on("end", finish)
      res.on("error", (e) => done(() => reject(netError(e, o.host, o.port))))
      res.on("close", finish)
    })
    req.end()
  })
}
