import type { IncomingHttpHeaders } from "node:http"

/** "::ffff:a.b.c.d" → "a.b.c.d"; everything else unchanged. */
export function normalizeIp(addr: string): string {
  const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(addr)
  return m ? m[1] : addr
}

/**
 * Client IP for throttling and audit. `server.ts` (sanitizeForwarded, §2.9) always overwrites
 * `x-forwarded-for` with the socket address, so this value can never be forged by the client.
 */
export function clientIp(headers: Headers | IncomingHttpHeaders): string {
  const v = headers instanceof Headers ? headers.get("x-forwarded-for") : headers["x-forwarded-for"]
  const s = Array.isArray(v) ? v[0] : v
  return (s ?? "").split(",")[0].trim()
}
