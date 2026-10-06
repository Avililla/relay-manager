// simulated (§4.8 driver 4): in-process board, only with RM_RELAY_SIMULATE=1. State per board id, in memory
// (inside this driver instance, which lives in the runtime registry), seeded from the persisted relayState.
import { RELAY_TEXT } from "@/lib/i18n/relays"
import { driverLabel } from "@/lib/i18n/status"
import { driverCapabilities } from "@/lib/relays/capabilities"
import { RelayDriverError, type BoardRef, type DriverDeps, type RelayDriver } from "../types"
import { channelCheck, driverRuntime } from "./common"

/** How long a "dS pulse" channel (options.sim.pulseChannels) stays ON after a toggle. */
const SIM_PULSE_MS = 50

export function createSimulatedDriver(deps: DriverDeps): RelayDriver {
  const rt = driverRuntime(deps)
  const boards = new Map<string, boolean[]>()
  const timers = new Map<string, NodeJS.Timeout>()

  function stateOf(board: BoardRef): boolean[] {
    let s = boards.get(board.id)
    if (!s) {
      s = Array.from({ length: board.relayCount }, (_, i) => board.relayState[i] === "1")
      boards.set(board.id, s)
    }
    while (s.length < board.relayCount) s.push(false)
    if (s.length > board.relayCount) s.length = board.relayCount
    return s
  }
  function later(board: BoardRef, channel: number, ms: number, fn: () => void): void {
    const key = `${board.id}:${channel}`
    clearTimeout(timers.get(key))
    const t = setTimeout(() => { timers.delete(key); fn() }, ms)
    t.unref()
    timers.set(key, t)
  }
  async function io(board: BoardRef, signal: AbortSignal): Promise<void> {
    const sim = board.options.sim ?? {}
    if (sim.latencyMs) await rt.sleep(sim.latencyMs, signal)
    if (sim.offline) throw new RelayDriverError(RELAY_TEXT.errSimOffline, "unreachable")
    if (sim.failRate && Math.random() < sim.failRate) throw new RelayDriverError(RELAY_TEXT.errSimFailure, "timeout")
  }
  const absolute = (board: BoardRef) => board.options.sim?.absoluteSet !== false

  return {
    id: "simulated",
    label: driverLabel("simulated"),
    capabilities: (b) => driverCapabilities("simulated", b),
    detect: async () => null,

    async readState(board, signal) {
      await io(board, signal)
      return [...stateOf(board)]
    },

    async setRelay(board, channel, on, signal) {
      channelCheck(channel, board.relayCount)
      await io(board, signal)
      const s = stateOf(board)
      if (s[channel - 1] === on) return
      if (board.options.sim?.pulseChannels?.includes(channel)) {
        // Behaves like a dS relay configured as a pulse: the toggle does not stick.
        s[channel - 1] = true
        later(board, channel, SIM_PULSE_MS, () => { s[channel - 1] = false })
        return
      }
      s[channel - 1] = on
    },

    async pulse(board, channel, ms, signal) {
      channelCheck(channel, board.relayCount)
      await io(board, signal)
      const s = stateOf(board)
      if (absolute(board)) {
        s[channel - 1] = true
        later(board, channel, ms, () => { s[channel - 1] = false })
        return
      }
      s[channel - 1] = !s[channel - 1]
      try { await rt.sleep(ms, signal) } catch { /* restore below */ }
      s[channel - 1] = !s[channel - 1]
    },
  }
}
