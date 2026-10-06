// "Identificar" (passive, never writes) and "Enviar retorno de carro" (explicit, one "\r") — §4.7, D3.
import { DEFAULT_LINE } from "@/lib/contracts/enums"
import type { ProbeResultDTO, ProbeState } from "@/lib/contracts/serial"
import { errorMessage } from "@/lib/i18n/errors"
import { SERIAL_ERROR } from "@/lib/i18n/serial"
import { DomainError } from "@/server/errors"
import type { Logger } from "@/server/log"
import type { ActorRef, AuditService, SerialProbeService } from "@/server/runtime/types"
import type { DeviceView, PortUsage } from "./console-manager"
import { mapOpenError, openWithDeadline, type PortHandle, type PortOpener } from "./port-factory"
import { classify, printableSample } from "./pure/classify"

export interface ProbeDeps {
  discovery: DeviceView
  openPort: PortOpener
  audit: AuditService
  log: Logger
  /** Ports the app already holds: the console manager's history, or the preview ring. */
  held: { history(stableKey: string): Buffer | null; isBound(stableKey: string): boolean }
  allowPoke: () => boolean
  usage: PortUsage
  timings?: { pokeListenMs?: number; pokeAfterMs?: number; bootExtraMs?: number }
  /** A hung open gives up after this (default 10 s) instead of hanging the action. */
  openTimeoutMs?: number
}

const MAX_BUF = 8192
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref())
const plain = (a: ActorRef): ActorRef => ({ kind: a.kind, id: a.id, name: a.name, ip: a.ip ?? null })

function openErrorState(err: unknown): { state: ProbeState; message: string } {
  const m = mapOpenError(err)
  const state: ProbeState = m.kind === "busy" ? "busy-other" : m.kind
  return { state, message: m.message }
}

class Listener {
  private buf = Buffer.alloc(0)
  constructor(h: PortHandle) {
    h.onData((chunk) => {
      this.buf = Buffer.concat([this.buf, chunk])
      if (this.buf.length > MAX_BUF) this.buf = this.buf.subarray(this.buf.length - MAX_BUF)
    })
  }
  text(): string { return this.buf.toString("latin1") }
}

export function createProbeService(d: ProbeDeps): SerialProbeService {
  const log = d.log.child("serial")
  const pokeListenMs = d.timings?.pokeListenMs ?? 300
  const pokeAfterMs = d.timings?.pokeAfterMs ?? 1500
  const bootExtraMs = d.timings?.bootExtraMs ?? 1500

  function result(stableKey: string, devNode: string | null, t0: number, p: Partial<ProbeResultDTO> & { state: ProbeState }): ProbeResultDTO {
    return { stableKey, devNode, hostname: null, openByApp: false, poked: false, sample: "", error: null, ms: Date.now() - t0, ...p }
  }

  async function probeOne(stableKey: string, baudRate: number, listenMs: number): Promise<ProbeResultDTO> {
    const t0 = Date.now()
    const dev = d.discovery.find(stableKey)
    if (!dev) return result(stableKey, null, t0, { state: "missing" })
    const held = d.held.history(stableKey)
    if (held) {
      const text = held.toString("latin1")
      const c = classify(text)
      return result(stableKey, dev.devNode, t0, { state: c.state, hostname: c.hostname, openByApp: true, sample: printableSample(text) })
    }
    let h: PortHandle
    try {
      h = await openWithDeadline(d.openPort, { path: dev.openPath, line: { ...DEFAULT_LINE, baudRate }, hupcl: false, lock: true }, d.openTimeoutMs)
    } catch (err) {
      const e = openErrorState(err)
      if (e.state === "busy-other") d.usage.busy.add(stableKey)
      return result(stableKey, dev.devNode, t0, { state: e.state, error: e.message })
    }
    d.usage.busy.delete(stableKey)
    const l = new Listener(h)
    try {
      await sleep(listenMs)
      const first = classify(l.text()).state
      if (first === "linux-booting" || first === "fsbl") await sleep(bootExtraMs) // still booting: keep listening, silently
    } finally {
      await h.close().catch(() => undefined)
    }
    const text = l.text()
    const c = classify(text)
    return result(stableKey, dev.devNode, t0, { state: c.state, hostname: c.hostname, sample: printableSample(text) })
  }

  return {
    async identify(stableKeys, opts, actor) {
      const keys = [...new Set(stableKeys)]
      const results = await Promise.all(keys.map((k) => probeOne(k, opts.baudRate, opts.listenMs)))
      d.audit.record({ actor: plain(actor), action: "console.probe", target: { type: "port" }, detail: { stableKeys: keys, results: results.map((r) => r.state) } })
      return results
    },

    async poke(stableKey, opts, actor) {
      if (!d.allowPoke()) throw new DomainError("DISABLED_BY_POLICY", SERIAL_ERROR.pokeDisabled)
      const t0 = Date.now()
      const dev = d.discovery.find(stableKey)
      if (!dev) throw new DomainError("DEVICE_NOT_FOUND", errorMessage("DEVICE_NOT_FOUND"))
      if (d.held.isBound(stableKey)) throw new DomainError("DEVICE_ALREADY_BOUND", SERIAL_ERROR.deviceBound)
      if (d.held.history(stableKey)) throw new DomainError("DEVICE_BUSY", SERIAL_ERROR.deviceBusy)
      const audit = (outcome: "ok" | "denied" | "error", r: { state: ProbeState; hostname: string | null }) => d.audit.record({
        actor: plain(actor), action: "console.poke", outcome, target: { type: "port", id: stableKey, name: dev.devNode },
        detail: { stableKey, state: r.state, hostname: r.hostname },
      })
      let h: PortHandle
      try {
        h = await openWithDeadline(d.openPort, { path: dev.openPath, line: { ...DEFAULT_LINE, baudRate: opts.baudRate }, hupcl: false, lock: true }, d.openTimeoutMs)
      } catch (err) {
        const e = openErrorState(err)
        if (e.state === "busy-other") d.usage.busy.add(stableKey)
        const r = result(stableKey, dev.devNode, t0, { state: e.state, error: e.message })
        audit("error", r)
        return r
      }
      const l = new Listener(h)
      let poked = false
      try {
        await sleep(pokeListenMs)
        const before = classify(l.text())
        if (before.state === "uboot-autoboot") {
          // Any byte stops U-Boot's autoboot: never send during the countdown.
          audit("denied", before)
          throw new DomainError("CONFLICT", SERIAL_ERROR.ubootCountdown)
        }
        await h.write(Buffer.from("\r"))
        poked = true
        await sleep(pokeAfterMs)
      } finally {
        await h.close().catch(() => undefined)
      }
      const text = l.text()
      const c = classify(text)
      const r = result(stableKey, dev.devNode, t0, { state: c.state, hostname: c.hostname, poked, sample: printableSample(text) })
      audit("ok", r)
      log.info("Retorno de carro enviado", { dispositivo: dev.devNode, estado: c.state, por: actor.name })
      return r
    },
  }
}
