import { afterEach, describe, expect, it, vi } from "vitest"
import type { BoardOptions } from "@/lib/contracts/relays"
import { createNullLogger } from "@/server/log"
import { createSimulator, type Simulator, type SimulatorOptions } from "../../../../scripts/sim/devantech-sim.mjs"
import { defaultTransports } from "../transport"
import type { BoardRef, DriverDeps } from "../types"
import { setAndVerify } from "../verify"
import { createDriverRegistry } from "../registry"
import { createDsAsciiDriver } from "./ds-ascii"
import { createDsHttpDriver } from "./ds-http"
import { createEthDriver } from "./eth"
import { createSimulatedDriver } from "./simulated"

const sims: Simulator[] = []
afterEach(async () => { await Promise.all(sims.splice(0).map((s) => s.stop())) })
async function sim(o: SimulatorOptions): Promise<Simulator> {
  const s = await createSimulator({ log: false, ...o })
  sims.push(s)
  return s
}
const deps = (over: Partial<DriverDeps> = {}): DriverDeps => ({ transports: defaultTransports, timeoutMs: 800, log: createNullLogger(), ...over })
const signal = () => AbortSignal.timeout(10_000)
const ctx = () => ({ signal: signal(), timeoutMs: 800 })
function board(s: Simulator, o: Partial<BoardRef>): BoardRef {
  return {
    id: "b1", name: "Placa 1", driver: "devantech-ds-http", host: s.host, httpPort: s.ports.http ?? 80, tcpPort: null,
    relayCount: s.relayCount, model: s.model, username: null, password: null, options: {}, relayState: "", ...o,
  }
}

describe("devantech-ds-http", () => {
  it("detects a dS378: model from the tag set, physical relayCount, toggleVar and hostname", async () => {
    const s = await sim({ model: "dS378", hostname: "banco-rele", toggleVar: "V20552" })
    const r = await createDsHttpDriver(deps()).detect(s.host, { httpPort: s.ports.http, tcpPort: null }, ctx())
    expect(r).toMatchObject({
      driver: "devantech-ds-http", confidence: "high", host: s.host, httpPort: s.ports.http, model: "dS378", moduleId: 35,
      relayCount: 8, hostname: "banco-rele", authRequired: false, options: { toggleVar: "V20552" },
    })
    expect(r?.evidence.join("\n")).toContain("/index.xml")
  })

  it("reports authRequired with low confidence when the web password page replaces the XML", async () => {
    const s = await sim({ model: "dS378", pass: "web-secret" })
    const r = await createDsHttpDriver(deps()).detect(s.host, { httpPort: s.ports.http, tcpPort: null }, ctx())
    expect(r).toMatchObject({ driver: "devantech-ds-http", authRequired: true, confidence: "low" })
  })

  it("does not match an ETH board or a closed port", async () => {
    const s = await sim({ model: "ETH008", user: "admin", pass: "password" })
    expect(await createDsHttpDriver(deps()).detect(s.host, { httpPort: s.ports.http, tcpPort: null }, ctx())).toBeNull()
    expect(await createDsHttpDriver(deps()).detect("127.0.0.1", { httpPort: 1, tcpPort: null }, ctx())).toBeNull()
  })

  it("sets ON and OFF by read-compare-toggle, and the verify read confirms it", async () => {
    const s = await sim({ model: "dS378" })
    const d = createDsHttpDriver(deps())
    const b = board(s, { options: { toggleVar: "V20944" } })
    expect((await setAndVerify(d, b, 2, true, signal(), { attempts: 5, intervalMs: 30 })).verified).toBe(true)
    expect(s.state()[1]).toBe(true)
    await d.setRelay(b, 2, true, signal())            // already ON: no toggle
    expect(s.state()[1]).toBe(true)
    expect((await setAndVerify(d, b, 2, false, signal(), { attempts: 5, intervalMs: 30 })).verified).toBe(true)
    expect(s.state()[1]).toBe(false)
    expect(await d.readState(b, signal())).toEqual(new Array(8).fill(false))
  })

  it("learns a missing toggleVar from /index.htm once and persists it through the controller callback", async () => {
    const s = await sim({ model: "dS378", toggleVar: "V20552" })
    const persisted: Array<[string, BoardOptions]> = []
    const d = createDsHttpDriver(deps({ persistOptions: async (id, o) => { persisted.push([id, o]) } }))
    const b = board(s, { options: {} })
    await d.setRelay(b, 1, true, signal())
    expect(s.state()[0]).toBe(true)
    expect(persisted).toEqual([["b1", { toggleVar: "V20552" }]])
  })

  it("refuses to write when the toggleVar cannot be learned", async () => {
    const s = await sim({ model: "dS378", pass: "web-secret" })
    const d = createDsHttpDriver(deps())
    await expect(d.setRelay(board(s, { options: {} }), 1, true, signal()))
      .rejects.toMatchObject({ kind: "config", message: "Falta la variable dScript (toggleVar): indícala en la placa" })
  })

  it("a relay configured as a pulse on the board does not stay ON: the verify fails", async () => {
    const s = await sim({ model: "dS378", pulse: { 3: 19 } })
    const d = createDsHttpDriver(deps())
    const r = await setAndVerify(d, board(s, { options: { toggleVar: "V20944" } }), 3, true, signal(), { attempts: 3, intervalMs: 150 })
    expect(r.verified).toBe(false)
    expect(s.state()[2]).toBe(false)
  })

  it("emulates a pulse: toggle, wait, toggle back", async () => {
    const s = await sim({ model: "dS378" })
    const d = createDsHttpDriver(deps())
    const b = board(s, { options: { toggleVar: "V20944" } })
    const p = d.pulse(b, 4, 200, signal())
    await vi.waitFor(() => expect(s.state()[3]).toBe(true))
    await p
    expect(s.state()[3]).toBe(false)
    expect(d.capabilities(b)).toMatchObject({ absoluteSet: false, toggle: "native", pulse: "emulated" })
  })

  it("readState is strict: a non-Devantech page is a protocol error", async () => {
    const s = await sim({ model: "ETH008" })
    await expect(createDsHttpDriver(deps()).readState(board(s, { relayCount: 8 }), signal()))
      .rejects.toMatchObject({ kind: "protocol", message: "Respuesta no reconocida: ¿es una placa Devantech?" })
  })
})

describe("devantech-ds-ascii", () => {
  it("detects with ST: model, relayCount and firmware", async () => {
    const s = await sim({ model: "dS2824", ascii: 0 })
    const r = await createDsAsciiDriver(deps()).detect(s.host, { httpPort: null, tcpPort: s.ports.ascii }, ctx())
    expect(r).toMatchObject({ driver: "devantech-ds-ascii", confidence: "high", model: "dS2824", moduleId: 34, relayCount: 24,
      firmware: "4.12", tcpPort: s.ports.ascii })
  })

  it("sets with SR n on|off and reads with GR n", async () => {
    const s = await sim({ model: "dS378", ascii: 0 })
    const d = createDsAsciiDriver(deps())
    const b = board(s, { driver: "devantech-ds-ascii", tcpPort: s.ports.ascii })
    await d.setRelay(b, 5, true, signal())
    expect(s.state()[4]).toBe(true)
    expect(await d.readState(b, signal())).toEqual([false, false, false, false, true, false, false, false])
    await d.setRelay(b, 5, false, signal())
    expect(s.state()[4]).toBe(false)
    const lines = s.requests.flatMap((q) => (q.proto === "ascii" ? [q.line] : []))
    expect(lines).toContain("SR 5 on")
    expect(lines).toContain("SR 5 off")
    expect(lines).toContain("GR 8")
  })

  it("reads over HTTP /index.xml with useHttpFallback (one request)", async () => {
    const s = await sim({ model: "dS378", ascii: 0 })
    s.setRelay(8, true)
    const d = createDsAsciiDriver(deps())
    const b = board(s, { driver: "devantech-ds-ascii", tcpPort: s.ports.ascii, options: { useHttpFallback: true } })
    expect((await d.readState(b, signal()))[7]).toBe(true)
    expect(s.requests.filter((q) => q.proto === "ascii")).toHaveLength(0)
  })

  it("pulses natively with SR n on <ms> (≥ 19) and rejects 4..18 before sending", async () => {
    const s = await sim({ model: "dS378", ascii: 0 })
    const d = createDsAsciiDriver(deps())
    const b = board(s, { driver: "devantech-ds-ascii", tcpPort: s.ports.ascii })
    await d.pulse(b, 2, 150, signal())
    expect(s.state()[1]).toBe(true)
    await vi.waitFor(() => expect(s.state()[1]).toBe(false), { timeout: 2000 })
    const before = s.requests.length
    await expect(d.pulse(b, 2, 10, signal())).rejects.toMatchObject({ kind: "config" })
    expect(s.requests.length).toBe(before)
    expect(d.capabilities(b)).toMatchObject({ absoluteSet: true, pulse: "native", pulseMs: { min: 19 } })
  })

  it("maps a closed port to unreachable", async () => {
    const s = await sim({ model: "dS378" })
    await expect(createDsAsciiDriver(deps()).readState(board(s, { driver: "devantech-ds-ascii", tcpPort: 1 }), signal()))
      .rejects.toMatchObject({ kind: "unreachable" })
  })
})

describe("devantech-eth", () => {
  it("detects with 0x10 and reports whether a TCP password is set (0x7A)", async () => {
    const a = await sim({ model: "ETH008", eth: 0 })
    const b = await sim({ model: "ETH8020", eth: 0, tcpPass: "secreto" })
    const d = createEthDriver(deps())
    expect(await d.detect(a.host, { httpPort: null, tcpPort: a.ports.eth }, ctx()))
      .toMatchObject({ driver: "devantech-eth", confidence: "high", model: "ETH008", moduleId: 19, relayCount: 8, authRequired: false })
    expect(await d.detect(b.host, { httpPort: null, tcpPort: b.ports.eth }, ctx()))
      .toMatchObject({ model: "ETH8020", relayCount: 20, authRequired: true })
  })

  it("sets, reads and pulses over TCP (0x20/0x21/0x24)", async () => {
    const s = await sim({ model: "ETH008", eth: 0 })
    const d = createEthDriver(deps())
    const b = board(s, { driver: "devantech-eth", tcpPort: s.ports.eth })
    await d.setRelay(b, 3, true, signal())
    expect(await d.readState(b, signal())).toEqual([false, false, true, false, false, false, false, false])
    await d.setRelay(b, 3, false, signal())
    expect(s.state()[2]).toBe(false)
    await d.pulse(b, 1, 200, signal())
    expect(s.state()[0]).toBe(true)
    expect(s.requests.some((q) => q.proto === "eth" && q.bytes[0] === 0x20 && q.bytes[1] === 1 && q.bytes[2] === 2)).toBe(true)
    await vi.waitFor(() => expect(s.state()[0]).toBe(false), { timeout: 2000 })
  })

  it("reads an ETH484 from the first byte of its 2-byte reply", async () => {
    const s = await sim({ model: "ETH484", eth: 0 })
    s.setRelay(4, true)
    const d = createEthDriver(deps())
    expect(await d.readState(board(s, { driver: "devantech-eth", tcpPort: s.ports.eth }), signal())).toEqual([false, false, false, true])
  })

  it("unlocks with the TCP password before a write; a wrong or missing password is an auth error", async () => {
    const s = await sim({ model: "ETH002", eth: 0, tcpPass: "secreto" })
    const d = createEthDriver(deps())
    await d.setRelay(board(s, { driver: "devantech-eth", tcpPort: s.ports.eth, password: "secreto" }), 2, true, signal())
    expect(s.state()[1]).toBe(true)
    await expect(d.setRelay(board(s, { driver: "devantech-eth", tcpPort: s.ports.eth, password: "mala" }), 2, false, signal()))
      .rejects.toMatchObject({ kind: "auth", message: "Contraseña TCP incorrecta" })
    await expect(d.setRelay(board(s, { driver: "devantech-eth", tcpPort: s.ports.eth }), 2, false, signal()))
      .rejects.toMatchObject({ kind: "auth" })
    expect(s.state()[1]).toBe(true)
  })

  it("writes over HTTP io.cgi with an Authorization header when options.transport is http", async () => {
    const s = await sim({ model: "ETH008", eth: 0, user: "admin", pass: "password" })
    const d = createEthDriver(deps())
    const b = board(s, { driver: "devantech-eth", tcpPort: s.ports.eth, username: null, password: "password", options: { transport: "http" } })
    await d.setRelay(b, 6, true, signal())
    expect(s.state()[5]).toBe(true)
    expect(s.requests.some((q) => q.proto === "http" && q.path === "/io.cgi" && q.query === "?DOA6=0")).toBe(true)
    await d.pulse(b, 7, 300, signal())
    expect(s.requests.some((q) => q.proto === "http" && q.query === "?DOA7=3")).toBe(true)
    await expect(d.setRelay({ ...b, password: "mala" }, 6, false, signal())).rejects.toMatchObject({ kind: "auth" })
  })
})

describe("simulated", () => {
  const ref = (options: BoardOptions = {}, relayState = ""): BoardRef => ({
    id: "sim1", name: "Simulada", driver: "simulated", host: "127.0.0.1", httpPort: 80, tcpPort: null, relayCount: 4,
    model: null, username: null, password: null, options, relayState,
  })

  it("has absolute set by default and toggle-only capabilities with sim.absoluteSet=false", () => {
    const d = createSimulatedDriver(deps())
    expect(d.capabilities(ref())).toMatchObject({ absoluteSet: true, pulse: "native" })
    expect(d.capabilities(ref({ sim: { absoluteSet: false } }))).toMatchObject({ absoluteSet: false, toggle: "native", pulse: "emulated" })
  })

  it("seeds its state from relayState and keeps it in memory per board", async () => {
    const d = createSimulatedDriver(deps())
    expect(await d.readState(ref({}, "0101"), signal())).toEqual([false, true, false, true])
    await d.setRelay(ref({}, "0101"), 1, true, signal())
    expect(await d.readState(ref({}, "0101"), signal())).toEqual([true, true, false, true])
  })

  it("offline and pulseChannels: unreachable, and toggles that do not stick", async () => {
    const d = createSimulatedDriver(deps())
    await expect(d.readState(ref({ sim: { offline: true } }), signal())).rejects.toMatchObject({ kind: "unreachable" })
    const b = ref({ sim: { pulseChannels: [2] } })
    await d.setRelay(b, 2, true, signal())
    const r = await setAndVerify(d, b, 2, true, signal(), { attempts: 2, intervalMs: 80 })
    expect(r.verified).toBe(false)
  })
})

describe("registry and autodetect", () => {
  it("suggests ds-ascii when ST answers and merges toggleVar and hostname from ds-http", async () => {
    const s = await sim({ model: "dS378", ascii: 0, hostname: "rele-lab" })
    const reg = createDriverRegistry(deps())
    const res = await reg.autodetect(s.host, { httpPort: s.ports.http, tcpPort: s.ports.ascii }, ctx())
    expect(res[0]).toMatchObject({ driver: "devantech-ds-ascii", model: "dS378", relayCount: 8, hostname: "rele-lab",
      httpPort: s.ports.http, options: { toggleVar: "V20944" } })
    expect(res.map((r) => r.driver)).toContain("devantech-ds-http")
  })

  it("falls back to ds-http when ST does not answer, and finds ETH boards", async () => {
    const a = await sim({ model: "dS378" })
    const reg = createDriverRegistry(deps())
    const ra = await reg.autodetect(a.host, { httpPort: a.ports.http, tcpPort: 1 }, ctx())
    expect(ra[0]?.driver).toBe("devantech-ds-http")
    const e = await sim({ model: "ETH484", eth: 0 })
    const re = await reg.autodetect(e.host, { httpPort: null, tcpPort: e.ports.eth }, ctx())
    expect(re[0]).toMatchObject({ driver: "devantech-eth", model: "ETH484", relayCount: 4 })
    expect(reg.get("simulated").id).toBe("simulated")
  })
})
