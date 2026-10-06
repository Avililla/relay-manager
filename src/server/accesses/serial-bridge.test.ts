import net from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import type { ConsoleRuntimeDTO } from "@/lib/contracts/serial"
import type { ConsoleTap } from "@/server/runtime/types"
import { SerialBridge, type BridgeEvent } from "./serial-bridge"

const closers: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const c of closers.splice(0).reverse()) await c() })

const rt = (status: ConsoleRuntimeDTO["status"], released: ConsoleRuntimeDTO["released"] = null): ConsoleRuntimeDTO => ({
  status, devNode: "/dev/ttyUSB0", detail: null, since: new Date().toISOString(), lastRxAt: null, lastLine: null, viewers: 0, released, capture: "active",
})

function fakeSource() {
  const taps = new Set<ConsoleTap>()
  const writes: Array<{ bytes: string; who: string }> = []
  const state = { open: true, gone: false }
  return {
    taps, writes, state,
    attachTap(_id: string, tap: ConsoleTap) {
      if (state.gone) return null
      taps.add(tap)
      return { history: Buffer.from("historial\r\n"), runtime: rt(state.open ? "open" : "released"), key: "UART0", label: "UART0", equipmentName: "Equipo A #01" }
    },
    detachTap(_id: string, tap: ConsoleTap) { taps.delete(tap) },
    writeFromTap(_id: string, bytes: Buffer, who: string) {
      if (!state.open) return "port-not-open" as const
      writes.push({ bytes: bytes.toString(), who })
      return "ok" as const
    },
    emit(s: string) { for (const t of taps) t.onData(Buffer.from(s)) },
    status(r: ConsoleRuntimeDTO) { for (const t of taps) t.onStatus(r) },
    gone() { state.gone = true; for (const t of [...taps]) t.onGone(); taps.clear() },
  }
}

async function start(opts: { writable?: () => boolean; max?: number } = {}) {
  const src = fakeSource()
  const events: BridgeEvent[] = []
  let touched = 0
  const b = new SerialBridge({
    bind: "127.0.0.1", port: 0, consoleId: "c1", source: src, maxConnections: opts.max ?? 4,
    writable: opts.writable ?? (() => true), onInput: () => { touched++ }, onEvent: (e) => events.push(e),
  })
  const port = await b.listen()
  closers.push(() => b.close())
  return { b, src, port, events, touched: () => touched }
}

function client(port: number) {
  return new Promise<{ s: net.Socket; text: () => string; closed: Promise<void> }>((resolve, reject) => {
    const s = net.connect({ host: "127.0.0.1", port })
    let buf = ""
    s.on("data", (d) => (buf += d.toString()))
    const closed = new Promise<void>((r) => s.once("close", () => r()))
    s.once("connect", () => resolve({ s, text: () => buf, closed }))
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

describe("SerialBridge", () => {
  it("sends a notice, the history, then live data; input goes to the console while writable", async () => {
    const { b, src, port, events, touched } = await start()
    const c = await client(port)
    await until(() => c.text().includes("historial"))
    expect(c.text()).toMatch(/Relay Manager · Equipo A #01 · UART0/)
    expect(c.text()).toMatch(/escritura permitida/)
    src.emit("login: ")
    await until(() => c.text().endsWith("login: "))
    c.s.write("root\n")
    await until(() => src.writes.length === 1)
    expect(src.writes[0]).toEqual({ bytes: "root\n", who: expect.stringMatching(/^tcp 127\.0\.0\.1$/) })
    expect(touched()).toBe(1)
    expect(b.connections()).toHaveLength(1)
    expect(events.map((e) => e.kind)).toEqual(["connect"])
  })

  it("read-only while not writable: input is dropped with a notice", async () => {
    let w = false
    const { b, src, port } = await start({ writable: () => w })
    const c = await client(port)
    await until(() => c.text().includes("historial"))
    expect(c.text()).toMatch(/solo lectura/)
    c.s.write("reboot\n")
    await until(() => /reserva el equipo para escribir/i.test(c.text().split("historial")[1] ?? ""))
    expect(src.writes).toEqual([])
    w = true
    b.writableChanged()
    await until(() => /escritura permitida/.test(c.text().split("historial")[1] ?? ""))
    c.s.write("ls\n")
    await until(() => src.writes.length === 1)
  })

  it("tells the clients when the port is released and when it comes back", async () => {
    const { src, port } = await start()
    const c = await client(port)
    await until(() => c.text().includes("historial"))
    src.state.open = false
    src.status(rt("released", { byName: "Ana", at: new Date().toISOString(), until: null }))
    await until(() => /Puerto soltado por Ana/.test(c.text()))
    c.s.write("x")
    await until(() => /no está abierta/.test(c.text()))
    src.state.open = true
    src.status(rt("open"))
    await until(() => /Consola abierta/.test(c.text()))
  })

  it("caps connections, closes everyone with a notice, and closes when the console goes away", async () => {
    const { b, src, port, events } = await start({ max: 1 })
    const a = await client(port)
    await until(() => a.text().includes("historial"))
    const x = await client(port)
    await x.closed
    expect(x.text()).toMatch(/Demasiadas conexiones/)
    expect(events.some((e) => e.kind === "refused")).toBe(true)
    src.gone()
    await a.closed
    expect(a.text()).toMatch(/consola se ha borrado/)
    await until(() => b.connections().length === 0)
    const y = await client(port)
    await y.closed
    await b.dropAll("Reserva liberada: se cierra el acceso")
  })

  it("dropAll sends the reason and closes", async () => {
    const { b, port } = await start()
    const c = await client(port)
    await until(() => c.text().includes("historial"))
    await b.dropAll("Reserva liberada: se cierra el acceso")
    await c.closed
    expect(c.text()).toMatch(/Reserva liberada: se cierra el acceso/)
  })
})
