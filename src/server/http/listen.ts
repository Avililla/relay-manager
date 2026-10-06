import fs from "node:fs"
import http, { type IncomingMessage, type ServerResponse } from "node:http"
import https from "node:https"
import type { AppConfig } from "@/server/config/schema"
import { sanitizeForwarded } from "./forwarded"
import { isOriginAllowed } from "./origin"

const SAFE = new Set(["GET", "HEAD", "OPTIONS"])

/**
 * 'request' listener: sanitizeForwarded → Origin gate for non-GET/HEAD/OPTIONS → handler (§2.9, D38).
 */
export function createRequestListener(
  cfg: Pick<AppConfig, "tls" | "port">,
  handle: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    sanitizeForwarded(req, cfg)
    if (!SAFE.has(req.method ?? "GET") && !isOriginAllowed(req, cfg)) {
      res.writeHead(403, { "content-type": "application/json", "cache-control": "no-store" })
      res.end('{"error":"FORBIDDEN_ORIGIN"}')
      return
    }
    void handle(req, res)
  }
}

/** HTTP, or HTTPS when RM_TLS_CERT/RM_TLS_KEY are set, with the §2.9 timeouts. */
export function createAppServer(cfg: Pick<AppConfig, "tls">): http.Server {
  const server: http.Server = cfg.tls
    ? https.createServer({ cert: fs.readFileSync(cfg.tls.certFile), key: fs.readFileSync(cfg.tls.keyFile) })
    : http.createServer()
  server.headersTimeout = 65_000
  server.requestTimeout = 60_000
  server.keepAliveTimeout = 5_000
  server.maxConnections = 1024
  return server
}

export class ListenError extends Error {
  readonly exitCode = 2
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "ListenError"
  }
}

/** listen(host, port) with Spanish messages for EADDRINUSE / EACCES (exit 2). */
export function listenServer(server: http.Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      server.off("listening", onListening)
      if (err.code === "EADDRINUSE") reject(new ListenError(`El puerto ${port} ya está en uso`, { cause: err }))
      else if (err.code === "EACCES") reject(new ListenError(`El puerto ${port} requiere privilegios: usa el 1024 o superior`, { cause: err }))
      else reject(err)
    }
    const onListening = () => {
      server.off("error", onError)
      resolve()
    }
    server.once("error", onError)
    server.once("listening", onListening)
    server.listen(port, host)
  })
}
