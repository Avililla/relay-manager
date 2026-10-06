import type { IncomingMessage } from "node:http"
import type { AppConfig } from "@/server/config/schema"
import { normalizeIp } from "@/server/request-meta"

const FORWARDED = ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-forwarded-port", "x-real-ip"] as const

/**
 * Deletes every client-supplied forwarded header and rewrites them from the socket (D38). Next only fills these
 * headers when they are absent, so without this a LAN client could forge its IP and its host.
 */
export function sanitizeForwarded(req: IncomingMessage, cfg: Pick<AppConfig, "tls" | "port">): void {
  for (const h of FORWARDED) delete req.headers[h]
  req.headers["x-forwarded-for"] = normalizeIp(req.socket.remoteAddress ?? "")
  req.headers["x-forwarded-proto"] = cfg.tls ? "https" : "http"
  req.headers["x-forwarded-port"] = String(cfg.port)
}
