import type { IncomingMessage } from "node:http"
import type { AppConfig } from "@/server/config/schema"

/**
 * Origin gate (§2.9): `Origin` is required, not "null", well formed, with the scheme of this server and the same
 * host:port as the `Host` header.
 */
export function isOriginAllowed(req: IncomingMessage, cfg: Pick<AppConfig, "tls">): boolean {
  const origin = req.headers.origin
  const host = req.headers.host
  if (typeof origin !== "string" || !origin || origin === "null" || typeof host !== "string" || !host) return false
  let u: URL
  try {
    u = new URL(origin)
  } catch {
    return false
  }
  if (u.protocol !== (cfg.tls ? "https:" : "http:")) return false
  return u.host === host.toLowerCase()
}
