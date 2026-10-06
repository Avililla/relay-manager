// GET /api/health of a running server (CLI `ping`, doctor `service.port`, Docker HEALTHCHECK, install.sh).
import http from "node:http"
import https from "node:https"
import { z } from "zod"
import type { AppConfig } from "@/server/config/schema"

const HealthBodySchema = z.object({ ok: z.boolean(), version: z.string().optional() })

/** Loopback for wildcard binds; brackets for IPv6 literals; https when TLS is on. */
export function healthUrl(cfg: Pick<AppConfig, "host" | "port" | "tls">): string {
  const host = cfg.host === "0.0.0.0" || cfg.host === "::" || cfg.host === "" ? "127.0.0.1" : cfg.host
  const h = host.includes(":") ? `[${host}]` : host
  return `${cfg.tls ? "https" : "http"}://${h}:${cfg.port}/api/health`
}

export interface ProbeResult { ok: boolean; url: string; version?: string; status?: number; error?: string }

const seconds = (ms: number) => new Intl.NumberFormat("es-ES", { maximumFractionDigits: 1 }).format(ms / 1000)

/** Self-signed certificates are tolerated here only (the request goes to our own server). */
export function probeHealth(cfg: Pick<AppConfig, "host" | "port" | "tls">, opts: { timeoutMs?: number } = {}): Promise<ProbeResult> {
  const url = healthUrl(cfg)
  const timeoutMs = opts.timeoutMs ?? 5000
  return new Promise((resolve) => {
    let done = false
    const finish = (r: ProbeResult) => {
      if (done) return
      done = true
      resolve(r)
    }
    const onResponse = (res: http.IncomingMessage) => {
      const chunks: Buffer[] = []
      let size = 0
      res.on("data", (c: Buffer) => {
        size += c.length
        if (size <= 64 * 1024) chunks.push(c)
      })
      res.on("end", () => {
        const status = res.statusCode ?? 0
        let parsed: z.infer<typeof HealthBodySchema> | null = null
        try {
          const r = HealthBodySchema.safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8")))
          parsed = r.success ? r.data : null
        } catch { /* not JSON */ }
        if (status === 200 && parsed?.ok === true) finish({ ok: true, url, status, version: parsed.version })
        else finish({ ok: false, url, status, error: `respuesta ${status}` })
      })
      res.on("error", (err) => finish({ ok: false, url, error: err.message }))
    }
    const common = { method: "GET", headers: { accept: "application/json" }, timeout: timeoutMs }
    const req = cfg.tls
      ? https.request(url, { ...common, rejectUnauthorized: false }, onResponse)
      : http.request(url, common, onResponse)
    const timer = setTimeout(() => {
      finish({ ok: false, url, error: `sin respuesta en ${seconds(timeoutMs)} s` })
      req.destroy()
    }, timeoutMs)
    timer.unref?.()
    req.on("timeout", () => {
      finish({ ok: false, url, error: `sin respuesta en ${seconds(timeoutMs)} s` })
      req.destroy()
    })
    req.on("error", (err: NodeJS.ErrnoException) => finish({ ok: false, url, error: err.code ?? err.message }))
    req.on("close", () => clearTimeout(timer))
    req.end()
  })
}
