// devantech-ds-ascii (§4.8 driver 2): dS ASCII command set on TCP 17123 (the factory default, D6).
// `SR <n> on|off [ms]`, `GR <n>`, `ST`, each terminated by CRLF. Absolute set and native pulses (≥ 19 ms).
import { RELAY_TEXT } from "@/lib/i18n/relays"
import { driverLabel } from "@/lib/i18n/status"
import { driverCapabilities, effectiveTcpPort } from "@/lib/relays/capabilities"
import { modelByName } from "../pure/models"
import { hasLine, parseGrReply, parseIndexXml, parseSrReply, parseStReply } from "../pure/ds"
import { RelayDriverError, type BoardRef, type DriverDeps, type RelayDriver, type TcpConversation } from "../types"
import { channelCheck, detectFailure, driverRuntime, probeTimeout } from "./common"

export const DS_ASCII_MIN_PULSE_MS = 19

export function createDsAsciiDriver(deps: DriverDeps): RelayDriver {
  const rt = driverRuntime(deps)

  async function withConn<T>(board: BoardRef, signal: AbortSignal, fn: (c: TcpConversation) => Promise<T>): Promise<T> {
    const port = effectiveTcpPort("devantech-ds-ascii", board.tcpPort) ?? 17123
    const c = await rt.t.tcpConnect({ host: board.host, port, timeoutMs: rt.timeoutMs, signal })
    try {
      return await fn(c)
    } finally {
      c.close()
    }
  }
  const line = (c: TcpConversation, cmd: string) => c.request(Buffer.from(`${cmd}\r\n`, "latin1"), hasLine).then((b) => b.toString("latin1"))

  return {
    id: "devantech-ds-ascii",
    label: driverLabel("devantech-ds-ascii"),
    capabilities: (b) => driverCapabilities("devantech-ds-ascii", b),

    async detect(host, ports, ctx) {
      const port = ports.tcpPort ?? 17123
      try {
        const c = await rt.probe.tcpConnect({ host, port, timeoutMs: probeTimeout(rt, ctx), signal: ctx.signal })
        let text: string
        try {
          // Read until 300 ms idle (500 ms timeout).
          text = (await c.request(Buffer.from("ST\r\n", "latin1"), () => false, { idleMs: 300, timeoutMs: 500 })).toString("latin1")
        } finally {
          c.close()
        }
        const st = parseStReply(text)
        if (!st) return null
        const info = modelByName(st.model)
        return {
          driver: "devantech-ds-ascii", confidence: info ? "high" : "medium", host, httpPort: null, tcpPort: port,
          model: info?.model ?? st.model, moduleId: info?.moduleId ?? null, relayCount: info?.relays ?? ctx.hint?.relayCount ?? null,
          hostname: ctx.hint?.hostname ?? null, mac: ctx.hint?.mac ?? null, firmware: st.firmware, authRequired: false, options: {},
          evidence: [`ST -> Module Type: ${st.model}`],
        }
      } catch (e) {
        return detectFailure(e)
      }
    },

    async readState(board, signal) {
      if (board.options.useHttpFallback) {
        const r = await rt.t.httpGet({ host: board.host, port: board.httpPort, path: "/index.xml", timeoutMs: rt.timeoutMs, signal })
        if (r.status !== 200) throw new RelayDriverError(RELAY_TEXT.errUnrecognised, "protocol")
        return parseIndexXml(r.body, board.relayCount)
      }
      return withConn(board, signal, async (c) => {
        const out: boolean[] = []
        for (let n = 1; n <= board.relayCount; n++) out.push(parseGrReply(await line(c, `GR ${n}`)))
        return out
      })
    },

    async setRelay(board, channel, on, signal) {
      channelCheck(channel, board.relayCount)
      await withConn(board, signal, async (c) => parseSrReply(await line(c, `SR ${channel} ${on ? "on" : "off"}`), channel))
    },

    async pulse(board, channel, ms, signal) {
      channelCheck(channel, board.relayCount)
      // The firmware treats 2 or less as a set, 3 as a toggle and silently ignores 4..18: never send those.
      if (!Number.isInteger(ms) || ms < DS_ASCII_MIN_PULSE_MS) throw new RelayDriverError(RELAY_TEXT.errPulseTooShort, "config")
      await withConn(board, signal, async (c) => parseSrReply(await line(c, `SR ${channel} on ${ms}`), channel))
    },
  }
}
