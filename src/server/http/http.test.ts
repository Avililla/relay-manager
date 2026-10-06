import http, { type IncomingMessage } from "node:http"
import net from "node:net"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it, vi } from "vitest"
import { sanitizeForwarded } from "./forwarded"
import { isOriginAllowed } from "./origin"
import { createRequestListener } from "./listen"
import { attachUpgradeRouter, rejectHttp } from "./upgrade"
import { clientIp, normalizeIp } from "@/server/request-meta"
import { createNullLogger } from "@/server/log"
import { testConfig } from "../../../test/helpers"
import type { SerialServices, UpgradeTarget } from "@/server/runtime/types"

function fakeReq(headers: Record<string, string>, remoteAddress = "::ffff:192.168.1.50"): IncomingMessage {
  return { headers: { ...headers }, socket: { remoteAddress }, method: "POST" } as unknown as IncomingMessage
}

describe("normalizeIp / clientIp", () => {
  it("maps IPv4-mapped IPv6 to plain IPv4", () => {
    expect(normalizeIp("::ffff:10.0.0.7")).toBe("10.0.0.7")
    expect(normalizeIp("fe80::1")).toBe("fe80::1")
    expect(normalizeIp("")).toBe("")
  })
  it("reads x-forwarded-for from Headers and from Node headers", () => {
    expect(clientIp(new Headers({ "x-forwarded-for": "10.0.0.1" }))).toBe("10.0.0.1")
    expect(clientIp({ "x-forwarded-for": "10.0.0.2" })).toBe("10.0.0.2")
    expect(clientIp({})).toBe("")
  })
})

describe("sanitizeForwarded", () => {
  it("replaces every client-supplied forwarded header with socket values", () => {
    const req = fakeReq({
      "x-forwarded-for": "6.6.6.6", "x-forwarded-host": "evil.com", "x-forwarded-proto": "https",
      "x-forwarded-port": "443", forwarded: "for=6.6.6.6;host=evil.com", "x-real-ip": "6.6.6.6", host: "bench:3000",
    })
    sanitizeForwarded(req, testConfig({ port: 3000 }))
    expect(req.headers["x-forwarded-for"]).toBe("192.168.1.50")
    expect(req.headers["x-forwarded-proto"]).toBe("http")
    expect(req.headers["x-forwarded-port"]).toBe("3000")
    expect(req.headers["x-forwarded-host"]).toBeUndefined()
    expect(req.headers.forwarded).toBeUndefined()
    expect(req.headers["x-real-ip"]).toBeUndefined()
    expect(req.headers.host).toBe("bench:3000")
  })
  it("uses https with TLS", () => {
    const req = fakeReq({})
    sanitizeForwarded(req, testConfig({ tls: { certFile: "/c", keyFile: "/k" } }))
    expect(req.headers["x-forwarded-proto"]).toBe("https")
  })
})

describe("isOriginAllowed", () => {
  const cfg = testConfig()
  const r = (h: Record<string, string>) => fakeReq(h)
  it("requires a same-origin Origin", () => {
    expect(isOriginAllowed(r({ host: "bench:3000", origin: "http://bench:3000" }), cfg)).toBe(true)
    expect(isOriginAllowed(r({ host: "bench:3000" }), cfg)).toBe(false)
    expect(isOriginAllowed(r({ host: "bench:3000", origin: "null" }), cfg)).toBe(false)
    expect(isOriginAllowed(r({ host: "bench:3000", origin: "http://bench:8080" }), cfg)).toBe(false)
    expect(isOriginAllowed(r({ host: "bench:3000", origin: "https://bench:3000" }), cfg)).toBe(false)
    expect(isOriginAllowed(r({ host: "bench:3000", origin: "::::" }), cfg)).toBe(false)
  })
  it("requires https with TLS", () => {
    const tls = testConfig({ tls: { certFile: "/c", keyFile: "/k" } })
    expect(isOriginAllowed(r({ host: "bench:3000", origin: "https://bench:3000" }), tls)).toBe(true)
    expect(isOriginAllowed(r({ host: "bench:3000", origin: "http://bench:3000" }), tls)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Real server tests
// ---------------------------------------------------------------------------
const servers: http.Server[] = []
const sockets = new Set<net.Socket>()
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections()
    // Upgraded sockets nobody handled are not tracked by closeAllConnections().
    for (const sock of sockets) sock.destroy()
    await new Promise<void>((resolve) => s.close(() => resolve()))
  }
  sockets.clear()
})

async function startServer(setup: (s: http.Server, port: () => number) => void): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer()
  servers.push(server)
  server.on("connection", (sock: net.Socket) => { sockets.add(sock); sock.on("close", () => sockets.delete(sock)) })
  let port = 0
  setup(server, () => port)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  port = (server.address() as AddressInfo).port
  return { server, port }
}

function request(port: number, method: string, headers: Record<string, string>): Promise<{ status: number; body: string; seen: Record<string, string | string[] | undefined> | null }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: "/x", headers }, (res) => {
      let body = ""
      res.setEncoding("utf8")
      res.on("data", (c: string) => { body += c })
      res.on("end", () => {
        let seen: Record<string, string | string[] | undefined> | null = null
        try { seen = JSON.parse(body).seen ?? null } catch { seen = null }
        resolve({ status: res.statusCode ?? 0, body, seen })
      })
    })
    req.on("error", reject)
    req.end()
  })
}

describe("request listener (Origin gate)", () => {
  async function gateServer() {
    const handle = vi.fn((req: IncomingMessage, res: http.ServerResponse) => {
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify({ seen: req.headers }))
    })
    const s = await startServer((server, port) => {
      server.on("request", (req, res) => createRequestListener(testConfig({ port: port() }), handle)(req, res))
    })
    return { ...s, handle }
  }

  it("refuses POST without Origin, with Origin null and with another port", async () => {
    const { port, handle } = await gateServer()
    const host = `127.0.0.1:${port}`
    for (const origin of [undefined, "null", `http://127.0.0.1:8080`, `https://${host}`]) {
      const res = await request(port, "POST", origin ? { origin, host } : { host })
      expect(res.status, String(origin)).toBe(403)
      expect(res.body).toBe('{"error":"FORBIDDEN_ORIGIN"}')
    }
    expect(handle).not.toHaveBeenCalled()
  })
  it("passes same-origin POST and GET without Origin, with rewritten forwarded headers", async () => {
    const { port, handle } = await gateServer()
    const host = `127.0.0.1:${port}`
    const post = await request(port, "POST", { origin: `http://${host}`, host, "x-forwarded-for": "6.6.6.6", "x-forwarded-host": "evil.com" })
    expect(post.status).toBe(200)
    expect(post.seen?.["x-forwarded-for"]).toBe("127.0.0.1")
    expect(post.seen?.["x-forwarded-host"]).toBeUndefined()
    const get = await request(port, "GET", { host })
    expect(get.status).toBe(200)
    expect(handle).toHaveBeenCalledTimes(2)
  })
})

describe("upgrade router", () => {
  async function upgradeServer() {
    const targets: UpgradeTarget[] = []
    const serial = {
      handleUpgrade: (_req: IncomingMessage, socket: net.Socket, _head: Buffer, target: UpgradeTarget) => {
        targets.push(target)
        rejectHttp(socket, 404)
      },
    } as unknown as SerialServices
    const s = await startServer((server, port) => {
      attachUpgradeRouter(server, { get config() { return testConfig({ port: port() }) }, serial, log: createNullLogger() })
    })
    return { ...s, targets }
  }

  function rawUpgrade(port: number, target: string, origin: string | null): Promise<{ statusLine: string; closed: boolean }> {
    return new Promise((resolve) => {
      const sock = net.connect(port, "127.0.0.1")
      let data = ""
      sock.on("data", (c) => { data += c.toString("latin1") })
      sock.on("error", () => {})
      sock.on("close", () => resolve({ statusLine: data.split("\r\n")[0] ?? "", closed: true }))
      sock.write(
        `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n` +
        `Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n` +
        (origin ? `Origin: ${origin}\r\n` : "") + "\r\n",
      )
      setTimeout(() => { sock.destroy(); resolve({ statusLine: data.split("\r\n")[0] ?? "", closed: false }) }, 3000)
    })
  }

  it("GET /ws/preview/%E0%A4%A with a valid Origin → 400 and the socket is closed", async () => {
    const { port, server, targets } = await upgradeServer()
    const r = await rawUpgrade(port, "/ws/preview/%E0%A4%A", `http://127.0.0.1:${port}`)
    expect(r.statusLine).toBe("HTTP/1.1 400 Bad Request")
    expect(r.closed).toBe(true)
    expect(targets).toHaveLength(0)
    const open = await new Promise<number>((resolve) => server.getConnections((_e, n) => resolve(n)))
    expect(open).toBe(0)
  })
  it("malformed absolute-form target → 400", async () => {
    const { port } = await upgradeServer()
    const r = await rawUpgrade(port, "http://[::1/ws/console/x", `http://127.0.0.1:${port}`)
    expect(r.statusLine).toBe("HTTP/1.1 400 Bad Request")
  })
  it("bad Origin → 403; missing Origin → 403", async () => {
    const { port, targets } = await upgradeServer()
    expect((await rawUpgrade(port, "/ws/console/abc", "http://evil.com")).statusLine).toBe("HTTP/1.1 403 Forbidden")
    expect((await rawUpgrade(port, "/ws/console/abc", null)).statusLine).toBe("HTTP/1.1 403 Forbidden")
    expect(targets).toHaveLength(0)
  })
  it("routes console and preview paths to rt.serial.handleUpgrade", async () => {
    const { port, targets } = await upgradeServer()
    const origin = `http://127.0.0.1:${port}`
    await rawUpgrade(port, "/ws/console/abc123", origin)
    await rawUpgrade(port, "/ws/preview/usb%3A1-3.1%3A1.0?baud=9600", origin)
    expect(targets).toEqual([
      { kind: "console", consoleId: "abc123" },
      { kind: "preview", stableKey: "usb:1-3.1:1.0", baudRate: 9600 },
    ])
  })
  it("unknown /ws/ path → 404; non-/ws/ paths are left alone", async () => {
    const { port } = await upgradeServer()
    const origin = `http://127.0.0.1:${port}`
    expect((await rawUpgrade(port, "/ws/other", origin)).statusLine).toBe("HTTP/1.1 404 Not Found")
    const r = await rawUpgrade(port, "/_next/webpack-hmr", origin)
    // Nobody handled it: the router returned without writing or closing.
    expect(r.statusLine).toBe("")
  })
})
