import net from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { TcpForward, type ForwardEvent } from "./tcp-forward"
import { PortBusyError } from "./listener"

const closers: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const c of closers.splice(0).reverse()) await c() })

function echoServer(opts: { halfClose?: boolean } = {}): Promise<{ port: number; ends: number }> {
  const state = { port: 0, ends: 0 }
  const srv = net.createServer({ allowHalfOpen: true }, (c) => {
    c.on("data", (d) => c.write(Buffer.concat([Buffer.from("eco:"), d])))
    c.on("end", () => {
      state.ends++
      if (opts.halfClose) c.end("adios\n")
      else c.end()
    })
  })
  closers.push(() => new Promise<void>((r) => srv.close(() => r())))
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => {
    state.port = (srv.address() as net.AddressInfo).port
    resolve(state)
  }))
}

async function startForward(target: { host: string; port: number }, max = 4) {
  const events: ForwardEvent[] = []
  const f = new TcpForward({ bind: "127.0.0.1", port: 0, target, maxConnections: max, connectTimeoutMs: 1000, onEvent: (e) => events.push(e) })
  const port = await f.listen()
  closers.push(() => f.close())
  return { f, port, events }
}

function client(port: number): Promise<{ s: net.Socket; data: () => string; ended: Promise<void> }> {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host: "127.0.0.1", port, allowHalfOpen: true })
    let buf = ""
    s.on("data", (d) => (buf += d.toString()))
    s.on("end", () => s.end())
    const ended = new Promise<void>((r) => s.once("close", () => r()))
    s.once("connect", () => resolve({ s, data: () => buf, ended }))
    s.once("error", reject)
    closers.push(() => { s.destroy() })
  })
}
const until = async (fn: () => boolean, ms = 3000) => {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error("timeout")
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe("TcpForward", () => {
  it("pipes both ways, counts bytes and reports connect/close", async () => {
    const echo = await echoServer()
    const { f, port, events } = await startForward({ host: "127.0.0.1", port: echo.port })
    const c = await client(port)
    c.s.write("hola")
    await until(() => c.data() === "eco:hola")
    await until(() => f.connections().length === 1)
    const conn = f.connections()[0]
    expect(conn.rxBytes).toBe(4)
    expect(conn.txBytes).toBe(8)
    expect(conn.remote).toMatch(/^127\.0\.0\.1:\d+$/)
    c.s.end()
    await c.ended
    await until(() => events.some((e) => e.kind === "close"))
    expect(events.map((e) => e.kind)).toEqual(["connect", "close"])
    expect(f.connections()).toEqual([])
  })

  it("keeps half-close: the target can still answer after the client ends", async () => {
    const echo = await echoServer({ halfClose: true })
    const { port } = await startForward({ host: "127.0.0.1", port: echo.port })
    const c = await client(port)
    c.s.end("x")
    await c.ended
    expect(c.data()).toBe("eco:xadios\n")
    expect(echo.ends).toBe(1)
  })

  it("refuses connections over the cap", async () => {
    const echo = await echoServer()
    const { f, port, events } = await startForward({ host: "127.0.0.1", port: echo.port }, 1)
    const a = await client(port)
    await until(() => f.connections().length === 1)
    const b = await client(port)
    await b.ended
    expect(events.some((e) => e.kind === "refused")).toBe(true)
    a.s.write("sigue")
    await until(() => a.data() === "eco:sigue")
  })

  it("closes the client when the target is unreachable and reports it", async () => {
    const dead = await new Promise<number>((resolve) => {
      const s = net.createServer().listen(0, "127.0.0.1", () => {
        const p = (s.address() as net.AddressInfo).port
        s.close(() => resolve(p))
      })
    })
    const { port, events } = await startForward({ host: "127.0.0.1", port: dead })
    const c = await client(port)
    await c.ended
    await until(() => events.some((e) => e.kind === "target-error"))
  })

  it("a source address the server no longer has fails with the given text, never from another address", async () => {
    const echo = await echoServer()
    const events: ForwardEvent[] = []
    // 192.0.2.1 (TEST-NET-1) is never an address of this machine: bind() fails with EADDRNOTAVAIL.
    const f = new TcpForward({
      bind: "127.0.0.1", port: 0, target: { host: "127.0.0.1", port: echo.port }, localAddress: "192.0.2.1", maxConnections: 2,
      bindError: "La VLAN del puerto 3 no está lista", onEvent: (e) => events.push(e),
    })
    const port = await f.listen()
    closers.push(() => f.close())
    const c = await client(port)
    await c.ended
    await until(() => events.some((e) => e.kind === "target-error"))
    expect(events.find((e) => e.kind === "target-error")).toMatchObject({ error: "La VLAN del puerto 3 no está lista" })
    expect(events.some((e) => e.kind === "connect")).toBe(false)
  })

  it("close() drops every connection and frees the port; a busy port is a PortBusyError", async () => {
    const echo = await echoServer()
    const { f, port } = await startForward({ host: "127.0.0.1", port: echo.port })
    const c = await client(port)
    await until(() => f.connections().length === 1)
    await f.close()
    await c.ended
    const blocker = net.createServer()
    await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", () => r()))
    closers.push(() => new Promise<void>((r) => blocker.close(() => r())))
    const busyPort = (blocker.address() as net.AddressInfo).port
    const g = new TcpForward({ bind: "127.0.0.1", port: busyPort, target: { host: "127.0.0.1", port: echo.port }, maxConnections: 1, onEvent: () => {} })
    await expect(g.listen()).rejects.toBeInstanceOf(PortBusyError)
  })
})
