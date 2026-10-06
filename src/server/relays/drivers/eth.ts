// devantech-eth (§4.8 driver 3): ETH002/008/484/8020 on TCP 17494 (binary), optional HTTP writes (io.cgi).
import { RELAY_TEXT } from "@/lib/i18n/relays"
import { driverLabel } from "@/lib/i18n/status"
import { driverCapabilities, effectiveTcpPort } from "@/lib/relays/capabilities"
import { ETH, outputsLength, parseModuleInfo, parseOutputs, pulseUnits } from "../pure/eth"
import { RelayDriverError, type BoardRef, type DriverDeps, type RelayDriver, type TcpConversation } from "../types"
import { channelCheck, detectFailure, driverRuntime, probeTimeout } from "./common"

const one = (b: Buffer) => b.length >= 1

export function createEthDriver(deps: DriverDeps): RelayDriver {
  const rt = driverRuntime(deps)

  async function withConn<T>(board: BoardRef, signal: AbortSignal, fn: (c: TcpConversation) => Promise<T>): Promise<T> {
    const port = effectiveTcpPort("devantech-eth", board.tcpPort) ?? 17494
    const c = await rt.t.tcpConnect({ host: board.host, port, timeoutMs: rt.timeoutMs, signal })
    try {
      return await fn(c)
    } finally {
      c.close()
    }
  }

  /** Before a write: 0x7A; 255 = no password, ≥ 3 = still unlocked; otherwise 0x79 + password must answer 1. */
  async function unlock(c: TcpConversation, board: BoardRef): Promise<void> {
    const left = (await c.request(Buffer.from([ETH.UNLOCK_TIME]), one))[0] ?? 0
    if (left === 255 || left >= 3) return
    if (!board.password) throw new RelayDriverError(RELAY_TEXT.errTcpPasswordMissing, "auth")
    const r = await c.request(Buffer.concat([Buffer.from([ETH.PASSWORD]), Buffer.from(board.password, "latin1")]), one)
    if (r[0] !== 1) throw new RelayDriverError(RELAY_TEXT.errTcpPassword, "auth")
  }

  async function command(board: BoardRef, op: number, channel: number, t: number, signal: AbortSignal): Promise<void> {
    await withConn(board, signal, async (c) => {
      await unlock(c, board)
      const r = await c.request(Buffer.from([op, channel, t]), one)
      if (r[0] !== 0) throw new RelayDriverError(RELAY_TEXT.errNack, "nack")
    })
  }

  async function httpCommand(board: BoardRef, query: string, signal: AbortSignal): Promise<void> {
    const r = await rt.t.httpGet({
      host: board.host, port: board.httpPort, path: `/io.cgi?${query}`, timeoutMs: rt.timeoutMs, signal,
      auth: { username: board.username || "admin", password: board.password ?? "" },
    })
    if (r.status === 401 || r.status === 403) throw new RelayDriverError(RELAY_TEXT.errHttpAuth, "auth")
    if (r.status !== 200) throw new RelayDriverError(RELAY_TEXT.errHttpStatus(r.status), "nack")
  }

  return {
    id: "devantech-eth",
    label: driverLabel("devantech-eth"),
    capabilities: (b) => driverCapabilities("devantech-eth", b),

    async detect(host, ports, ctx) {
      const port = ports.tcpPort ?? 17494
      try {
        const c = await rt.probe.tcpConnect({ host, port, timeoutMs: probeTimeout(rt, ctx), signal: ctx.signal })
        try {
          const info = parseModuleInfo(await c.request(Buffer.from([ETH.MODULE_INFO]), (b) => b.length >= 3))
          if (!info) return null
          const evidence = [`0x10 -> módulo ${info.moduleId} (${info.model}), firmware ${info.fw}`]
          let authRequired = false
          const lock = await c.request(Buffer.from([ETH.UNLOCK_TIME]), one).catch(detectFailure)
          if (lock) {
            authRequired = lock[0] !== 255
            evidence.push(`0x7A -> ${authRequired ? "contraseña TCP activada" : "sin contraseña TCP"}`)
          }
          return {
            driver: "devantech-eth", confidence: "high", host, httpPort: null, tcpPort: port,
            model: info.model, moduleId: info.moduleId, relayCount: info.relays, hostname: ctx.hint?.hostname ?? null,
            mac: ctx.hint?.mac ?? null, firmware: String(info.fw), authRequired, options: {}, evidence,
          }
        } finally {
          c.close()
        }
      } catch (e) {
        return detectFailure(e)
      }
    },

    async readState(board, signal) {
      const need = outputsLength(board.relayCount)
      return withConn(board, signal, async (c) => parseOutputs(await c.request(Buffer.from([ETH.GET_OUTPUTS]), (b) => b.length >= need), board.relayCount))
    },

    async setRelay(board, channel, on, signal) {
      channelCheck(channel, board.relayCount)
      if (board.options.transport === "http") return httpCommand(board, `DO${on ? "A" : "I"}${channel}=0`, signal)
      return command(board, on ? ETH.ACTIVE : ETH.INACTIVE, channel, 0, signal)
    },

    async pulse(board, channel, ms, signal) {
      channelCheck(channel, board.relayCount)
      const t = pulseUnits(ms)
      if (board.options.transport === "http") return httpCommand(board, `DOA${channel}=${t}`, signal)
      return command(board, ETH.ACTIVE, channel, t, signal)
    },
  }
}
