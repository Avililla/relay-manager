import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createNullLogger } from "@/server/log"
import { createSimulator, type Simulator } from "../../../../scripts/sim/devantech-sim.mjs"
import { defaultTransports } from "../transport"
import type { HttpGetOptions, RelayTransports, TcpConnectOptions } from "../types"
import { createDriverRegistry } from "../registry"
import { assertSafeHttpProbe, assertSafeProbe, SAFE_HTTP_PATHS } from "./safety"

const FORBIDDEN_17123 = [0x31, 0x32, 0x37, 0x38, 0x39]
const FORBIDDEN_17494 = [0x20, 0x21, 0x23, 0x3a]

describe("assertSafeProbe", () => {
  it("allows only ST on 17123 and 0x10/0x24/0x7A on 17494", () => {
    expect(() => assertSafeProbe(17123, Buffer.from("ST\r\n"))).not.toThrow()
    for (const b of [0x10, 0x24, 0x7a]) expect(() => assertSafeProbe(17494, Buffer.from([b]))).not.toThrow()
    for (const b of FORBIDDEN_17123) expect(() => assertSafeProbe(17123, Buffer.from([b, 1, 1]))).toThrow()
    for (const b of FORBIDDEN_17494) expect(() => assertSafeProbe(17494, Buffer.from([b, 1, 0]))).toThrow()
    expect(() => assertSafeProbe(17123, Buffer.from([0x10]))).toThrow()
    expect(() => assertSafeProbe(17494, Buffer.from("ST\r\n"))).toThrow()
    expect(() => assertSafeProbe(17123, Buffer.from("SR 1 on\r\n"))).toThrow()
    expect(() => assertSafeProbe(17123, Buffer.from("GR 1\r\n"))).toThrow()
  })

  it("on any other port allows only the union of the safe payloads", () => {
    expect(() => assertSafeProbe(20001, Buffer.from("ST\r\n"))).not.toThrow()
    expect(() => assertSafeProbe(20001, Buffer.from([0x10]))).not.toThrow()
    for (const b of [...FORBIDDEN_17123, ...FORBIDDEN_17494]) expect(() => assertSafeProbe(20001, Buffer.from([b]))).toThrow()
    expect(() => assertSafeProbe(20001, Buffer.from([0x79, 0x61]))).toThrow()
    expect(() => assertSafeProbe(20001, Buffer.alloc(0))).toThrow()
  })

  it("allows HTTP GET on /index.xml, /index.htm, /status.xml and / only", () => {
    expect(SAFE_HTTP_PATHS).toEqual(["/index.xml", "/index.htm", "/status.xml", "/"])
    for (const p of SAFE_HTTP_PATHS) expect(() => assertSafeHttpProbe("GET", p)).not.toThrow()
    expect(() => assertSafeHttpProbe("GET", "/dscript.cgi?V20944=1")).toThrow()
    expect(() => assertSafeHttpProbe("GET", "/io.cgi?DOA1=0")).toThrow()
    expect(() => assertSafeHttpProbe("GET", "/index.xml?x=1")).toThrow()
    expect(() => assertSafeHttpProbe("POST", "/index.xml")).toThrow()
  })
})

describe("every detect path is read-only (spy on the transports)", () => {
  const sims: Simulator[] = []
  const http: HttpGetOptions[] = []
  const tcp: Array<{ port: number; bytes: number[] }> = []
  const spy: RelayTransports = {
    httpGet: (o) => { http.push(o); return defaultTransports.httpGet(o) },
    tcpConnect: async (o: TcpConnectOptions) => {
      const conv = await defaultTransports.tcpConnect(o)
      return {
        host: conv.host, port: conv.port, close: () => conv.close(),
        request: (data, until, opts) => { tcp.push({ port: o.port, bytes: [...data] }); return conv.request(data, until, opts) },
      }
    },
    tcpProbe: (o) => defaultTransports.tcpProbe(o),
  }
  beforeAll(async () => {
    sims.push(await createSimulator({ log: false, model: "dS378", ascii: 0 }))
    sims.push(await createSimulator({ log: false, model: "dS2832", ascii: 0, pass: "web" }))
    sims.push(await createSimulator({ log: false, model: "ETH008", eth: 0, tcpPass: "x", user: "admin", pass: "password" }))
    sims.push(await createSimulator({ log: false, model: "ETH484", eth: 0 }))
  })
  afterAll(async () => { await Promise.all(sims.map((s) => s.stop())) })

  it("never sends a write command during autodetect, whatever the port combination", async () => {
    const reg = createDriverRegistry({ transports: spy, timeoutMs: 600, log: createNullLogger() })
    const ctx = { signal: AbortSignal.timeout(20_000), timeoutMs: 600 }
    for (const s of sims) {
      const tcpPorts = [s.ports.ascii, s.ports.eth, null].filter((p, i, a) => a.indexOf(p) === i)
      for (const tcpPort of tcpPorts) await reg.autodetect(s.host, { httpPort: s.ports.http, tcpPort }, ctx)
      for (const id of ["devantech-ds-http", "devantech-ds-ascii", "devantech-eth", "simulated"] as const) {
        await reg.get(id).detect(s.host, { httpPort: s.ports.http, tcpPort: s.ports.ascii ?? s.ports.eth }, ctx)
      }
    }
    expect(http.length).toBeGreaterThan(0)
    expect(tcp.length).toBeGreaterThan(0)
    for (const h of http) expect(SAFE_HTTP_PATHS).toContain(h.path)
    for (const t of tcp) {
      expect([...FORBIDDEN_17123, ...FORBIDDEN_17494]).not.toContain(t.bytes[0])
      expect(["ST\r\n", "\x10", "\x24", "\x7a"]).toContain(Buffer.from(t.bytes).toString("latin1"))
    }
    // And the boards saw no write either.
    for (const s of sims) {
      for (const q of s.requests) {
        if (q.proto === "http") expect(["/dscript.cgi", "/io.cgi"]).not.toContain(q.path)
        if (q.proto === "ascii") expect(q.line).toBe("ST")
        if (q.proto === "eth") expect(["ST\r\n", "\x10", "\x24", "\x7a"]).toContain(Buffer.from(q.bytes).toString("latin1"))
      }
      expect(s.state().every((v) => v === false)).toBe(true)
    }
  })
})
