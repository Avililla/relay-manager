import { describe, expect, it } from "vitest"
import { createLogger, isUnderJournald } from "./log"

function sink() {
  const out: string[] = []
  const err: string[] = []
  return { out, err, sink: { out: (l: string) => { out.push(l) }, err: (l: string) => { err.push(l) } } }
}
const now = () => new Date("2026-09-23T10:00:00.000Z")

describe("logger (§2.6)", () => {
  it("plain format with component and key=value; warn/error go to stderr", () => {
    const s = sink()
    const log = createLogger({ level: "info", journald: false, sink: s.sink, now }).child("serial")
    log.info("Puerto abierto", { puerto: "/dev/ttyUSB0", baudios: 115200 })
    log.warn("Aviso con espacios", { detalle: "dos palabras" })
    log.debug("oculto")
    expect(s.out).toEqual(["2026-09-23T10:00:00.000Z INFO  [serial] Puerto abierto puerto=/dev/ttyUSB0 baudios=115200"])
    expect(s.err).toEqual(['2026-09-23T10:00:00.000Z WARN  [serial] Aviso con espacios detalle="dos palabras"'])
  })
  it("journald format uses the syslog priority prefix", () => {
    const s = sink()
    const log = createLogger({ level: "debug", journald: true, sink: s.sink, now }).child("http")
    log.debug("d")
    log.info("i")
    log.warn("w")
    log.error("e")
    expect(s.out).toEqual(["<7>[http] d", "<6>[http] i"])
    expect(s.err).toEqual(["<4>[http] w", "<3>[http] e"])
  })
  it("logs a one-line error summary, and the stack once at debug level", () => {
    const s = sink()
    const log = createLogger({ level: "debug", journald: true, sink: s.sink, now }).child("db")
    log.error("Fallo", { err: new Error("boom"), ref: "abcd1234" })
    expect(s.err).toEqual(['<3>[db] Fallo ref=abcd1234 error="Error: boom"'])
    expect(s.out).toHaveLength(1)
    expect(s.out[0]).toMatch(/^<7>\[db\] Error: boom\n\s+at /)
    const quiet = sink()
    createLogger({ level: "info", journald: true, sink: quiet.sink }).error("Fallo", { err: new Error("x") })
    expect(quiet.out).toEqual([])
  })
  it("an inherited JOURNAL_STREAM that is not our stderr is not journald", () => {
    expect(isUnderJournald({ JOURNAL_STREAM: "1:1" })).toBe(false)
    expect(isUnderJournald({})).toBe(false)
  })
})
