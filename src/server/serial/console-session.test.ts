import { describe, expect, it } from "vitest"
import type { WsServerMsg } from "@/lib/contracts/ws"
import { closeReason, WsPeer, type WsLike } from "./console-session"

class FakeWs implements WsLike {
  bufferedAmount = 0
  readyState = 1
  sent: Array<{ data: Buffer | string; binary: boolean }> = []
  closed: { code: number; reason: string } | null = null
  terminated = false
  pings = 0
  send(data: Buffer | string, opts: { binary: boolean }, cb?: (err?: Error) => void): void {
    this.sent.push({ data, binary: opts.binary })
    cb?.()
  }
  close(code?: number, reason?: string): void { this.closed = { code: code ?? 1000, reason: reason ?? "" } }
  terminate(): void { this.terminated = true }
  ping(): void { this.pings++ }
  json(): WsServerMsg[] {
    return this.sent.filter((s) => !s.binary).map((s) => JSON.parse(String(s.data)) as WsServerMsg)
  }
}

describe("WsPeer backpressure (§5.5)", () => {
  it("drops live data above 1 MiB buffered, then sends gap with the dropped count below 256 KiB", () => {
    const ws = new FakeWs()
    let t = 0
    const peer = new WsPeer(ws, { now: () => t })
    peer.sendBinary(Buffer.alloc(10))
    ws.bufferedAmount = 1_100_000
    peer.sendBinary(Buffer.alloc(100))
    peer.sendBinary(Buffer.alloc(50))
    expect(ws.sent.filter((s) => s.binary)).toHaveLength(1)
    ws.bufferedAmount = 300_000
    peer.tick()
    expect(ws.json()).toEqual([])                         // still above the low-water mark
    ws.bufferedAmount = 100_000
    peer.sendBinary(Buffer.alloc(7))
    expect(ws.json()).toEqual([{ t: "gap", droppedBytes: 150 }])
    expect(ws.sent.filter((s) => s.binary)).toHaveLength(2)
    t += 1
    expect(peer.droppedTotal).toBe(150)
  })

  it("resumes from tick() without new data", () => {
    const ws = new FakeWs()
    const peer = new WsPeer(ws, { now: () => 0 })
    ws.bufferedAmount = 2_000_000
    peer.sendBinary(Buffer.alloc(100))
    ws.bufferedAmount = 0
    peer.tick()
    expect(ws.json()).toEqual([{ t: "gap", droppedBytes: 100 }])
  })

  it("history is never dropped", () => {
    const ws = new FakeWs()
    const peer = new WsPeer(ws, { now: () => 0 })
    ws.bufferedAmount = 2_000_000
    peer.sendBinary(Buffer.alloc(100), { history: true })
    expect(ws.sent).toHaveLength(1)
  })

  it("closes 4008 when more than 8 MiB stay buffered for 10 s", () => {
    const ws = new FakeWs()
    let t = 0
    const peer = new WsPeer(ws, { now: () => t })
    ws.bufferedAmount = 9_000_000
    peer.tick()
    t = 9_000
    peer.tick()
    expect(ws.closed).toBeNull()
    t = 10_500
    peer.tick()
    expect(ws.closed?.code).toBe(4008)
  })

  it("the slow timer resets when the buffer drains", () => {
    const ws = new FakeWs()
    let t = 0
    const peer = new WsPeer(ws, { now: () => t })
    ws.bufferedAmount = 9_000_000
    peer.tick()
    t = 5_000
    ws.bufferedAmount = 0
    peer.tick()
    ws.bufferedAmount = 9_000_000
    t = 11_000
    peer.tick()
    expect(ws.closed).toBeNull()
  })

  it("liveness: terminates after two missed pongs", () => {
    const ws = new FakeWs()
    const peer = new WsPeer(ws, { now: () => 0 })
    peer.heartbeat()
    peer.heartbeat()
    expect(ws.terminated).toBe(false)
    expect(ws.pings).toBe(2)
    peer.heartbeat()
    expect(ws.terminated).toBe(true)
    const ws2 = new FakeWs()
    const p2 = new WsPeer(ws2, { now: () => 0 })
    p2.heartbeat()
    p2.pong()
    p2.heartbeat()
    p2.pong()
    p2.heartbeat()
    expect(ws2.terminated).toBe(false)
  })

  it("counts bytes and never sends after close", () => {
    const ws = new FakeWs()
    const peer = new WsPeer(ws, { now: () => 0 })
    peer.sendBinary(Buffer.alloc(10))
    peer.close(1000, "ok")
    peer.sendBinary(Buffer.alloc(10))
    peer.sendJson({ t: "pong", at: 1, serverNow: "x" })
    expect(peer.bytesOut).toBe(10)
    expect(ws.sent).toHaveLength(1)
  })
})

describe("closeReason", () => {
  it("fits in 123 UTF-8 bytes", () => {
    const r = closeReason(`Puerto asignado a ${"Ñandú ".repeat(40)} · UART0`)
    expect(Buffer.byteLength(r)).toBeLessThanOrEqual(123)
    expect(closeReason("Sesión no válida")).toBe("Sesión no válida")
  })
})
