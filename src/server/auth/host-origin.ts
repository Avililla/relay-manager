import { NextRequest } from "next/server"
import { tryGetRuntime } from "@/server/runtime/registry"

function scheme(): "http" | "https" {
  return tryGetRuntime()?.config.tls ? "https" : "http"
}

/** Origin built from the Host header (forwarded headers are never trusted, D38). */
export function hostOrigin(headers: Headers): string {
  const host = headers.get("host") ?? "localhost"
  return `${scheme()}://${host}`
}

type NextRequestInit = NonNullable<ConstructorParameters<typeof NextRequest>[1]> & { duplex?: "half" }

/**
 * A NextRequest whose `url` is exactly the one given. NextRequest normalises 127.x.x.x and [::1] to `localhost` in
 * `url`, and Auth.js takes its baseUrl from `url`: a login on http://127.0.0.1:PORT would redirect to localhost.
 */
class HostOriginRequest extends NextRequest {
  readonly #href: string
  constructor(href: string, init: NextRequestInit) {
    super(href, init)
    this.#href = href
  }
  override get url(): string {
    return this.#href
  }
}

/**
 * Rebuilds request.url from Host (§6.4). Without it a custom server builds http://0.0.0.0:PORT/... redirects, and
 * NextRequest turns a Host of 127.0.0.1 or [::1] into localhost.
 */
export function withHostOrigin(req: NextRequest): NextRequest {
  const url = new URL(req.nextUrl.pathname + req.nextUrl.search, hostOrigin(req.headers))
  if (url.href === req.url) return req
  const init: NextRequestInit = {
    method: req.method, headers: req.headers, body: req.body, redirect: req.redirect, signal: req.signal,
  }
  if (req.body) init.duplex = "half"
  return new HostOriginRequest(url.href, init)
}

/** Absolute URL for proxy redirects, on the host the browser used. */
export function absoluteUrl(req: { headers: Headers }, path: string): URL {
  return new URL(path, hostOrigin(req.headers))
}
