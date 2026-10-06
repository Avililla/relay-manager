import http from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { testConfig } from "../../../test/helpers"
import { healthUrl, ping } from "./ping"

const servers: http.Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()) })))
})

async function serve(handler: http.RequestListener): Promise<number> {
  const s = http.createServer(handler)
  servers.push(s)
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r))
  return (s.address() as AddressInfo).port
}

describe("healthUrl", () => {
  it("uses loopback for wildcard binds, keeps a specific host, brackets IPv6 and picks the scheme", () => {
    expect(healthUrl(testConfig({ host: "0.0.0.0", port: 3000 }))).toBe("http://127.0.0.1:3000/api/health")
    expect(healthUrl(testConfig({ host: "::", port: 3000 }))).toBe("http://127.0.0.1:3000/api/health")
    expect(healthUrl(testConfig({ host: "198.51.100.10", port: 8080 }))).toBe("http://198.51.100.10:8080/api/health")
    expect(healthUrl(testConfig({ host: "fe80::1", port: 3000 }))).toBe("http://[fe80::1]:3000/api/health")
    expect(healthUrl(testConfig({ host: "banco.local", port: 3000, tls: { certFile: "/c", keyFile: "/k" } }))).toBe("https://banco.local:3000/api/health")
  })
})

describe("ping", () => {
  it("ok when /api/health answers {ok:true}", async () => {
    let seenPath = ""
    const port = await serve((req, res) => {
      seenPath = req.url ?? ""
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ ok: true, version: "2.0.0" }))
    })
    const r = await ping(testConfig({ host: "0.0.0.0", port }))
    expect(r).toMatchObject({ ok: true, version: "2.0.0", url: `http://127.0.0.1:${port}/api/health` })
    expect(seenPath).toBe("/api/health")
  })

  it("not ok on an error status, a body without ok:true, or no listener", async () => {
    const bad = await serve((_req, res) => { res.writeHead(503); res.end("{}") })
    expect((await ping(testConfig({ host: "127.0.0.1", port: bad }))).ok).toBe(false)
    const notOk = await serve((_req, res) => { res.writeHead(200); res.end(JSON.stringify({ ok: false })) })
    expect((await ping(testConfig({ host: "127.0.0.1", port: notOk }))).ok).toBe(false)
    const closed = await serve((_req, res) => { res.end() })
    const s = servers.pop()
    await new Promise<void>((r) => s?.close(() => r()))
    const r = await ping(testConfig({ host: "127.0.0.1", port: closed }))
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/ECONNREFUSED/)
  })

  it("times out", async () => {
    const port = await serve(() => { /* never answers */ })
    const r = await ping(testConfig({ host: "127.0.0.1", port }), { timeoutMs: 200 })
    expect(r.ok).toBe(false)
    expect(r.error).toBe("sin respuesta en 0,2 s")
  })
})
