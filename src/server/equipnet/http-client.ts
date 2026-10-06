// Minimal HTTP/1.1 client for the switch management pages: one request per connection (the Easy Smart web server
// closes every connection and rejects some of what fetch/undici sends), bound to a local address so policy routing
// sends it out of the equipment adapter, with a timeout and a size cap.
import http from "node:http"

export interface HttpRequest {
  host: string
  port: number
  method: "GET" | "POST"
  path: string
  body?: string
  localAddress?: string | null
  timeoutMs?: number
  headers?: Record<string, string>
}
export interface HttpResponse { status: number; headers: http.IncomingHttpHeaders; body: Buffer }
export type HttpFn = (r: HttpRequest) => Promise<HttpResponse>

const MAX_BODY = 2 * 1024 * 1024

export class HttpError extends Error {
  readonly code: string
  constructor(message: string, code: string) {
    super(message)
    this.name = "HttpError"
    this.code = code
  }
}

export const httpRequest: HttpFn = (r) => new Promise((resolve, reject) => {
  const headers: Record<string, string | number> = {
    Host: r.port === 80 ? r.host : `${r.host}:${r.port}`, Connection: "close", Accept: "*/*",
    Referer: `http://${r.port === 80 ? r.host : `${r.host}:${r.port}`}/`, ...(r.headers ?? {}),
  }
  if (r.body !== undefined) {
    headers["Content-Type"] = "application/x-www-form-urlencoded"
    headers["Content-Length"] = Buffer.byteLength(r.body)
  }
  const req = http.request({
    host: r.host, port: r.port, method: r.method, path: r.path, headers, agent: false,
    ...(r.localAddress ? { localAddress: r.localAddress } : {}),
  }, (res) => {
    const chunks: Buffer[] = []
    let size = 0
    res.on("data", (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) req.destroy(new HttpError("respuesta demasiado grande", "TOO_LARGE"))
      else chunks.push(c)
    })
    res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }))
    res.on("error", (e) => reject(e))
  })
  const timer = setTimeout(() => req.destroy(new HttpError("tiempo de espera agotado", "TIMEOUT")), r.timeoutMs ?? 8000)
  timer.unref()
  req.on("close", () => clearTimeout(timer))
  req.on("error", (e: NodeJS.ErrnoException) => reject(e instanceof HttpError ? e : new HttpError(e.message, e.code ?? "ERROR")))
  if (r.body !== undefined) req.write(r.body)
  req.end()
})
