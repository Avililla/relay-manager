import http from "node:http"
import net from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { httpGet } from "./http"
import { tcpConnect, tcpProbe, TCP_MAX_BYTES } from "./tcp"

const closers: Array<() => Promise<void>> = []
afterEach(async () => { await Promise.all(closers.splice(0).map((c) => c())) })

async function tcpServer(onData: (sock: net.Socket, data: Buffer) => void): Promise<number> {
  const srv = net.createServer((s) => { s.on("data", (d) => onData(s, d)); s.on("error", () => {}) })
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()))
  closers.push(() => new Promise((r) => srv.close(() => r())))
  return (srv.address() as net.AddressInfo).port
}
async function httpServer(handler: http.RequestListener): Promise<number> {
  const srv = http.createServer(handler)
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()))
  closers.push(() => new Promise((r) => { srv.closeAllConnections(); srv.close(() => r()) }))
  return (srv.address() as net.AddressInfo).port
}

describe("tcp transport", () => {
  it("caps the receive buffer at 64 KiB (excess → protocol error)", async () => {
    const port = await tcpServer((s) => { s.write(Buffer.alloc(TCP_MAX_BYTES + 4096, 0x41)) })
    const c = await tcpConnect({ host: "127.0.0.1", port, timeoutMs: 1000 })
    await expect(c.request(Buffer.from([0x24]), () => false, { timeoutMs: 1000 }))
      .rejects.toMatchObject({ kind: "protocol", message: "Respuesta demasiado grande: no parece una placa Devantech" })
    c.close()
    expect(TCP_MAX_BYTES).toBe(64 * 1024)
  })

  it("resolves when `until` matches, keeps one connection for several requests, and times out", async () => {
    const port = await tcpServer((s, d) => {
      const t = d.toString()
      if (t === "GR 1\r\n") s.write("Act")
      if (t === "GR 1\r\n") setTimeout(() => s.write("ive\r\n"), 20)
      if (t === "GR 2\r\n") s.write("InActive\r\n")
    })
    const c = await tcpConnect({ host: "127.0.0.1", port, timeoutMs: 1000 })
    const crlf = (b: Buffer) => b.includes("\r\n")
    expect((await c.request(Buffer.from("GR 1\r\n"), crlf)).toString()).toBe("Active\r\n")
    expect((await c.request(Buffer.from("GR 2\r\n"), crlf)).toString()).toBe("InActive\r\n")
    await expect(c.request(Buffer.from("XX\r\n"), crlf, { timeoutMs: 100 })).rejects.toMatchObject({ kind: "timeout" })
    c.close()
  })

  it("idle mode resolves with what arrived once the line goes quiet", async () => {
    const port = await tcpServer((s) => { s.write("Module Type: dS378\r\n"); setTimeout(() => s.write("System Firmware Version: 4.12\r\n"), 30) })
    const c = await tcpConnect({ host: "127.0.0.1", port, timeoutMs: 1000 })
    const b = await c.request(Buffer.from("ST\r\n"), () => false, { idleMs: 120, timeoutMs: 500 })
    expect(b.toString()).toContain("4.12")
    c.close()
  })

  it("maps a refused connection to unreachable; tcpProbe never throws", async () => {
    await expect(tcpConnect({ host: "127.0.0.1", port: 1, timeoutMs: 500 })).rejects.toMatchObject({ kind: "unreachable" })
    expect(await tcpProbe({ host: "127.0.0.1", port: 1, timeoutMs: 300 })).toBe(false)
    const port = await tcpServer(() => {})
    expect(await tcpProbe({ host: "127.0.0.1", port, timeoutMs: 300 })).toBe(true)
  })

  it("honours an aborted signal", async () => {
    const port = await tcpServer(() => {})
    const ac = new AbortController()
    const c = await tcpConnect({ host: "127.0.0.1", port, timeoutMs: 5000, signal: ac.signal })
    const p = c.request(Buffer.from("ST\r\n"), () => false, { timeoutMs: 5000 })
    ac.abort()
    await expect(p).rejects.toBeInstanceOf(Error)
  })
})

describe("http transport", () => {
  it("sends Connection: close and an Authorization: Basic header, never credentials in the URL", async () => {
    let seen: http.IncomingHttpHeaders = {}
    let url = ""
    const port = await httpServer((req, res) => { seen = req.headers; url = req.url ?? ""; res.end("ok") })
    const r = await httpGet({ host: "127.0.0.1", port, path: "/io.cgi?DOA1=0", timeoutMs: 1000, auth: { username: "admin", password: "password" } })
    expect(r.status).toBe(200)
    expect(seen.authorization).toBe(`Basic ${Buffer.from("admin:password").toString("base64")}`)
    expect(seen.connection).toBe("close")
    expect(url).toBe("/io.cgi?DOA1=0")
    await expect(httpGet({ host: "admin:x@127.0.0.1", port, path: "/", timeoutMs: 500 })).rejects.toMatchObject({ kind: "config" })
    await expect(httpGet({ host: "127.0.0.1", port, path: "http://evil/", timeoutMs: 500 })).rejects.toMatchObject({ kind: "config" })
  })

  it("never follows redirects and caps the body at 64 KiB", async () => {
    let hits = 0
    const port = await httpServer((req, res) => {
      hits++
      if (req.url === "/r") { res.writeHead(302, { location: "/big" }); res.end(); return }
      res.end(Buffer.alloc(200 * 1024, 0x61))
    })
    const r = await httpGet({ host: "127.0.0.1", port, path: "/r", timeoutMs: 1000 })
    expect(r.status).toBe(302)
    expect(hits).toBe(1)
    const big = await httpGet({ host: "127.0.0.1", port, path: "/big", timeoutMs: 1000 })
    expect(big.truncated).toBe(true)
    expect(big.body.length).toBe(64 * 1024)
  })

  it("maps timeouts and refused connections", async () => {
    const port = await httpServer(() => { /* never answers */ })
    await expect(httpGet({ host: "127.0.0.1", port, path: "/", timeoutMs: 150 })).rejects.toMatchObject({ kind: "timeout" })
    await expect(httpGet({ host: "127.0.0.1", port: 1, path: "/", timeoutMs: 300 })).rejects.toMatchObject({ kind: "unreachable" })
  })
})
