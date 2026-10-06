// Relay controller (§4.9): one BoardController per board with a promise-chain mutex; poll loop per enabled board;
// set/pulse with the holder check and verify; coalesced refresh; read-only test.
import type { PrismaClient } from "@/generated/prisma/client"
import type { DriverId } from "@/lib/contracts/enums"
import { DriverIdSchema } from "@/lib/contracts/enums"
import {
  BoardOptionsSchema, type BoardConnectionInput, type BoardOptions, type BoardRuntimeDTO, type DetectResultDTO,
  type DriverCapabilitiesDTO, type RelayChannelStateDTO,
} from "@/lib/contracts/relays"
import { RELAY_TEXT } from "@/lib/i18n/relays"
import { effectiveTcpPort } from "@/lib/relays/capabilities"
import { pulseRangeError } from "@/lib/relays/pulse"
import type { AppConfig } from "@/server/config/schema"
import { DomainError, isDomainError } from "@/server/errors"
import type { Logger } from "@/server/log"
import type { ActorRef, AuditService, EventBus, RelayController, ReservationService, UserActor } from "@/server/runtime/types"
import { withOpSignal } from "./op-signal"
import { createDriverRegistry, type DriverRegistry } from "./registry"
import { defaultTransports } from "./transport"
import { isRelayDriverError, type BoardRef, type RelayDriver, type RelayTransports } from "./types"
import { abortableSleep, setAndVerify } from "./verify"

export interface TimerApi {
  set(fn: () => void, ms: number): unknown
  clear(handle: unknown): void
}
const realTimers: TimerApi = {
  set(fn, ms) { const t = setTimeout(fn, ms); t.unref(); return t },
  clear(h) { clearTimeout(h as NodeJS.Timeout) },
}

export interface RelayControllerDeps {
  prisma: PrismaClient
  bus: EventBus
  audit: AuditService
  reservations: ReservationService
  log: Logger
  config: AppConfig
  /** Default: the real drivers over `transports`, with the toggleVar persistence callback. */
  drivers?: DriverRegistry
  transports?: RelayTransports
  now?: () => Date
  timers?: TimerApi
  verify?: { attempts: number; intervalMs: number }
  refreshWindowMs?: number
}

export interface KnownBoardRef { id: string; name: string; host: string; httpPort: number; mac: string | null }

export interface RelayControllerImpl extends RelayController {
  stop(): Promise<void>
  /** Boards for the discovery cross-reference (MAC, then host). */
  knownBoards(): KnownBoardRef[]
  /** Poll timers currently scheduled (0 with no enabled board). */
  activeTimers(): number
}

interface ChannelInfo { id: string; equipmentId: string; equipmentName: string; boardId: string; channel: number; label: string; position: number }

interface BoardState {
  ref: BoardRef
  mac: string | null
  enabled: boolean
  driver: RelayDriver
  tail: Promise<unknown>
  states: Array<boolean | null>
  online: boolean | null
  lastSeenAt: Date | null
  lastError: string | null
  timer: unknown
  hasTimer: boolean
  disposed: boolean
  refreshing: Promise<BoardRuntimeDTO> | null
  lastRefreshAt: number
  lastRefresh: BoardRuntimeDTO | null
}

const iso = (d: Date | null) => (d ? d.toISOString() : null)
const sameStates = (a: Array<boolean | null>, b: Array<boolean | null>) => a.length === b.length && a.every((v, i) => v === b[i])

export function createRelayController(deps: RelayControllerDeps): RelayControllerImpl {
  const log = deps.log.child("relays")
  const now = deps.now ?? (() => new Date())
  const timers = deps.timers ?? realTimers
  const verifyOpts = deps.verify ?? { attempts: 5, intervalMs: 150 }
  const refreshWindowMs = deps.refreshWindowMs ?? 2000
  const cfg = deps.config.relays
  const life = new AbortController()
  let stopped = false

  const boards = new Map<string, BoardState>()
  let channels = new Map<string, ChannelInfo>()
  let byEquipment = new Map<string, ChannelInfo[]>()
  let reloadTail: Promise<unknown> = Promise.resolve()

  async function persistOptions(boardId: string, options: BoardOptions): Promise<void> {
    const b = boards.get(boardId)
    if (b) b.ref.options = options
    await deps.prisma.relayBoard.update({ where: { id: boardId }, data: { options } }).catch((err: unknown) => {
      log.error("No se ha podido guardar la configuración de la placa", { err, placa: boardId })
    })
  }
  const drivers = deps.drivers ?? createDriverRegistry({
    transports: deps.transports ?? defaultTransports, timeoutMs: cfg.timeoutMs, log: deps.log, persistOptions,
  })

  // ---------------------------------------------------------------- helpers

  function lock<T>(b: BoardState, fn: () => Promise<T>): Promise<T> {
    const run = b.tail.then(fn, fn)
    b.tail = run.catch(() => undefined)
    return run
  }
  /**
   * Runs one board operation with the lifecycle signal plus a generous overall cap (the transports have their own
   * per-request timeout). Never AbortSignal.any with `life.signal`: it leaks one composite signal per call (op-signal.ts).
   */
  const withOp = <T>(fn: (signal: AbortSignal) => Promise<T>, extraMs = 0): Promise<T> =>
    withOpSignal(life.signal, Math.max(10_000, cfg.timeoutMs * 8) + extraMs, fn)

  function caps(b: BoardState): DriverCapabilitiesDTO {
    return b.driver.capabilities(b.ref)
  }
  function stale(b: BoardState): boolean {
    return !b.enabled || b.online !== true
  }
  function runtimeOf(b: BoardState): BoardRuntimeDTO {
    return {
      online: b.enabled ? b.online : null,
      lastSeenAt: iso(b.lastSeenAt),
      lastError: b.lastError,
      states: b.enabled ? [...b.states] : b.states.map(() => null),
      stale: stale(b),
      capabilities: caps(b),
    }
  }
  function channelDTO(c: ChannelInfo): RelayChannelStateDTO {
    const b = boards.get(c.boardId)
    if (!b || !b.enabled) return { channelId: c.id, on: null, stale: true }
    return { channelId: c.id, on: b.states[c.channel - 1] ?? null, stale: stale(b) }
  }

  function publish(b: BoardState): void {
    deps.bus.publish({ type: "board.status", boardId: b.ref.id, runtime: runtimeOf(b) }, { kind: "admins" })
    const at = now().toISOString()
    const perEq = new Map<string, ChannelInfo[]>()
    for (const c of channels.values()) {
      if (c.boardId !== b.ref.id) continue
      const l = perEq.get(c.equipmentId) ?? []
      l.push(c)
      perEq.set(c.equipmentId, l)
    }
    for (const [equipmentId, list] of perEq) {
      list.sort((x, y) => x.position - y.position)
      deps.bus.publish({ type: "relay.state", equipmentId, channels: list.map(channelDTO), at }, { kind: "equipment", equipmentId })
    }
  }

  async function persist(b: BoardState): Promise<void> {
    const relayState = b.states.every((v) => v !== null) ? b.states.map((v) => (v ? "1" : "0")).join("") : undefined
    await deps.prisma.relayBoard.update({
      where: { id: b.ref.id },
      data: { online: b.online === true, lastSeenAt: b.lastSeenAt, lastError: b.lastError, ...(relayState !== undefined ? { relayState } : {}) },
    }).catch((err: unknown) => {
      // The board may have been deleted meanwhile (P2025): the next reload() drops it.
      if (!b.disposed) log.warn("No se ha podido guardar el estado de la placa", { placa: b.ref.name, error: String(err) })
    })
  }

  /** Applies a read (or a failure) and, on a change, persists, publishes board.status and relay.state. */
  async function apply(b: BoardState, result: { states: boolean[] } | { error: string }): Promise<boolean> {
    const before = { states: [...b.states], online: b.online, lastError: b.lastError }
    if ("states" in result) {
      b.states = Array.from({ length: b.ref.relayCount }, (_, i) => result.states[i] ?? null)
      if (b.online !== true) log.info(RELAY_TEXT.logBoardOnline, { placa: b.ref.name, host: b.ref.host })
      b.online = true
      b.lastSeenAt = now()
      b.lastError = null
    } else {
      if (b.online !== false) log.warn(RELAY_TEXT.logBoardOffline, { placa: b.ref.name, host: b.ref.host, error: result.error })
      b.online = false
      b.lastError = result.error
    }
    const changed = !sameStates(before.states, b.states) || before.online !== b.online || before.lastError !== b.lastError
    if (changed && !b.disposed) {
      await persist(b)
      publish(b)
    }
    return changed
  }

  function errorText(e: unknown): string {
    if (isRelayDriverError(e)) return e.message
    if (e instanceof Error && e.name === "TimeoutError") return RELAY_TEXT.errTimeoutGeneric
    return e instanceof Error ? e.message : String(e)
  }

  /**
   * Whether a failed set/pulse means the board is not answering (→ offline, stale). A board that answered but refused
   * the command (auth, config, nack, protocol, unsupported) stays online: the error is audited and returned only.
   */
  function isBoardFailure(e: unknown): boolean {
    if (isRelayDriverError(e)) return e.kind === "unreachable" || e.kind === "timeout"
    if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) return true
    const code = typeof e === "object" && e !== null ? (e as { code?: unknown }).code : undefined
    return typeof code === "string" && /^E[A-Z]+$/.test(code) // plain network error (ECONNREFUSED, EHOSTUNREACH…)
  }

  /** set/pulse failure: a board failure is applied (offline, published); a refusal is only logged. */
  async function commandFailed(b: BoardState, e: unknown): Promise<void> {
    if (life.signal.aborted) return
    if (isBoardFailure(e)) await lock(b, () => apply(b, { error: errorText(e) }))
    else log.warn("La placa ha rechazado la orden", { placa: b.ref.name, error: errorText(e) })
  }

  async function pollNow(b: BoardState): Promise<BoardRuntimeDTO> {
    return lock(b, async () => {
      if (b.disposed || !b.enabled) return runtimeOf(b)
      try {
        const states = await withOp((signal) => b.driver.readState(b.ref, signal))
        await apply(b, { states })
      } catch (e) {
        if (!life.signal.aborted) await apply(b, { error: errorText(e) })
      }
      return runtimeOf(b)
    })
  }

  function schedule(b: BoardState, ms: number): void {
    if (b.hasTimer) timers.clear(b.timer)
    b.hasTimer = false
    if (stopped || b.disposed || !b.enabled) return
    b.hasTimer = true
    b.timer = timers.set(() => {
      b.hasTimer = false
      void pollNow(b).then(() => schedule(b, b.online === false ? cfg.offlinePollMs : cfg.pollMs))
    }, ms)
  }
  function unschedule(b: BoardState): void {
    if (b.hasTimer) timers.clear(b.timer)
    b.hasTimer = false
  }

  function parseOptions(raw: unknown, name: string): BoardOptions {
    const p = BoardOptionsSchema.safeParse(raw ?? {})
    if (!p.success) {
      log.warn("Opciones de placa no válidas: se ignoran", { placa: name })
      return {}
    }
    return p.data
  }

  // ---------------------------------------------------------------- reload

  async function doReload(): Promise<void> {
    const rows = await deps.prisma.relayBoard.findMany({
      include: { channels: { include: { equipment: { select: { id: true, name: true } } } } },
    })
    const seen = new Set<string>()
    const nextChannels = new Map<string, ChannelInfo>()
    const nextByEq = new Map<string, ChannelInfo[]>()
    const changed: BoardState[] = []
    for (const r of rows) {
      const driverId = DriverIdSchema.safeParse(r.driver)
      if (!driverId.success) { log.warn("Controlador de placa desconocido: se ignora", { placa: r.name, controlador: r.driver }); continue }
      seen.add(r.id)
      const ref: BoardRef = {
        id: r.id, name: r.name, driver: driverId.data as DriverId, host: r.host, httpPort: r.httpPort,
        tcpPort: effectiveTcpPort(driverId.data, r.tcpPort), relayCount: r.relayCount, model: r.model,
        username: r.username, password: r.password, options: parseOptions(r.options, r.name), relayState: r.relayState,
      }
      const enabled = r.enabled && !(driverId.data === "simulated" && !cfg.simulate)
      let b = boards.get(r.id)
      const connectionChanged = b !== undefined && (b.ref.driver !== ref.driver || b.ref.host !== ref.host || b.ref.httpPort !== ref.httpPort ||
        b.ref.tcpPort !== ref.tcpPort || b.ref.relayCount !== ref.relayCount)
      if (!b) {
        b = {
          ref, mac: r.mac, enabled, driver: drivers.get(ref.driver), tail: Promise.resolve(),
          states: new Array<boolean | null>(ref.relayCount).fill(null), online: null, lastSeenAt: r.lastSeenAt, lastError: r.lastError,
          timer: null, hasTimer: false, disposed: false, refreshing: null, lastRefreshAt: 0, lastRefresh: null,
        }
        boards.set(r.id, b)
        if (enabled) schedule(b, 0)
      } else {
        const wasEnabled = b.enabled
        b.ref = ref
        b.mac = r.mac
        b.driver = drivers.get(ref.driver)
        b.enabled = enabled
        if (connectionChanged) {
          b.states = new Array<boolean | null>(ref.relayCount).fill(null)
          b.online = null
        }
        if (!enabled) {
          unschedule(b)
          if (wasEnabled) changed.push(b)
        } else if (!wasEnabled || connectionChanged || !b.hasTimer) {
          if (!wasEnabled) b.online = null
          schedule(b, 0)
        }
      }
      for (const c of r.channels) {
        const info: ChannelInfo = { id: c.id, equipmentId: c.equipmentId, equipmentName: c.equipment.name, boardId: r.id, channel: c.channel, label: c.label, position: c.position }
        nextChannels.set(c.id, info)
        const l = nextByEq.get(c.equipmentId) ?? []
        l.push(info)
        nextByEq.set(c.equipmentId, l)
      }
    }
    for (const [id, b] of boards) {
      if (seen.has(id)) continue
      b.disposed = true
      unschedule(b)
      boards.delete(id)
    }
    for (const l of nextByEq.values()) l.sort((a, b) => a.position - b.position)
    channels = nextChannels
    byEquipment = nextByEq
    for (const b of changed) publish(b) // disabled: its channels are now stale
  }

  function reload(): Promise<void> {
    const run = reloadTail.then(doReload, doReload)
    reloadTail = run.catch(() => undefined)
    return run
  }

  // ---------------------------------------------------------------- set / pulse

  async function loadChannel(equipmentId: string, channelId: string) {
    const ch = await deps.prisma.relayChannel.findUnique({
      where: { id: channelId },
      include: { board: { select: { id: true, name: true } }, equipment: { select: { id: true, name: true } } },
    })
    if (!ch || ch.equipmentId !== equipmentId) throw new DomainError("NOT_FOUND", RELAY_TEXT.errChannelNotFound)
    let b = boards.get(ch.boardId)
    if (!b) { await reload(); b = boards.get(ch.boardId) }
    if (!b) throw new DomainError("NOT_FOUND", RELAY_TEXT.errChannelNotFound)
    return { ch, b }
  }

  /** §4.9 order: channel of this equipment (NOT_FOUND), reservation holder (NOT_HOLDER), then the board must be enabled. */
  function requireUsable(equipmentId: string, actor: UserActor, b: BoardState): void {
    if (!deps.reservations.isHolder(equipmentId, actor.id)) throw new DomainError("NOT_HOLDER", RELAY_TEXT.errNotHolder)
    if (!b.enabled) throw new DomainError("DRIVER_ERROR", RELAY_TEXT.errBoardDisabled(b.ref.name))
  }

  function driverFailure(b: BoardState, e: unknown): DomainError {
    const detail = errorText(e)
    return new DomainError("DRIVER_ERROR", RELAY_TEXT.errBoardFailed(b.ref.name, detail), undefined, { detail })
  }

  async function set(equipmentId: string, channelId: string, on: boolean, actor: UserActor): Promise<RelayChannelStateDTO> {
    const { ch, b } = await loadChannel(equipmentId, channelId)
    requireUsable(equipmentId, actor, b)
    let before = b.states[ch.channel - 1] ?? null
    const audit = (outcome: "ok" | "error", after: boolean | null, verified: boolean, error?: string) => deps.audit.record({
      actor, action: "relay.set", outcome, equipment: { id: ch.equipment.id, name: ch.equipment.name },
      target: { type: "relay", id: ch.id, name: ch.label },
      detail: { boardId: b.ref.id, channel: ch.channel, before, after, verified, ...(error ? { error } : {}) },
    })
    let result: { states: boolean[]; verified: boolean }
    try {
      result = await lock(b, async () => {
        // Queued behind other commands: the reservation may have expired or been released meanwhile.
        requireUsable(equipmentId, actor, b)
        before = b.states[ch.channel - 1] ?? null
        const r = await withOp((signal) => setAndVerify(b.driver, b.ref, ch.channel, on, signal, { ...verifyOpts, sleep: abortableSleep }))
        await apply(b, { states: r.states })
        return r
      })
    } catch (e) {
      if (isDomainError(e)) throw e // refused inside the mutex (NOT_HOLDER, disabled): the board was never reached
      await commandFailed(b, e)
      audit("error", null, false, errorText(e))
      throw driverFailure(b, e)
    }
    const after = result.states[ch.channel - 1] ?? null
    if (!result.verified) {
      audit("error", after, false)
      throw new DomainError("DRIVER_ERROR", RELAY_TEXT.errNotChanged(ch.label))
    }
    audit("ok", after, true)
    deps.reservations.touch(equipmentId, actor.id, "relay")
    return { channelId: ch.id, on: after, stale: stale(b) }
  }

  async function pulse(equipmentId: string, channelId: string, ms: number, actor: UserActor): Promise<void> {
    const { ch, b } = await loadChannel(equipmentId, channelId)
    requireUsable(equipmentId, actor, b)
    const c = caps(b)
    const rangeError = pulseRangeError(ms, c)
    if (rangeError) throw new DomainError("VALIDATION", rangeError, { ms: [rangeError] })
    const emulated = c.pulse === "emulated"
    const audit = (outcome: "ok" | "error", error?: string) => deps.audit.record({
      actor, action: "relay.pulse", outcome, equipment: { id: ch.equipment.id, name: ch.equipment.name },
      target: { type: "relay", id: ch.id, name: ch.label },
      detail: { boardId: b.ref.id, channel: ch.channel, ms, emulated, ...(error ? { error } : {}) },
    })
    let interrupted = false
    try {
      await lock(b, async () => {
        requireUsable(equipmentId, actor, b) // re-checked once this command holds the board
        await withOp(async (signal) => {
          await b.driver.pulse(b.ref, ch.channel, ms, signal)
          // An emulated pulse cut short (stop() or the op deadline) restores the relay early: not a full pulse.
          if (emulated && signal.aborted) interrupted = true
        }, ms)
      })
    } catch (e) {
      if (isDomainError(e)) throw e
      await commandFailed(b, e)
      audit("error", errorText(e))
      throw driverFailure(b, e)
    }
    if (interrupted) {
      audit("error", RELAY_TEXT.auditPulseInterrupted)
      throw new DomainError("DRIVER_ERROR", RELAY_TEXT.errPulseInterrupted(ch.label))
    }
    audit("ok")
    deps.reservations.touch(equipmentId, actor.id, "relay")
    // Show the state during the pulse, then the final one.
    void pollNow(b)
    if (!emulated) timers.set(() => { if (!b.disposed && !stopped) void pollNow(b) }, ms + 250)
  }

  // ---------------------------------------------------------------- refresh / test

  function refresh(boardId: string): Promise<BoardRuntimeDTO> {
    const b = boards.get(boardId)
    if (!b) return Promise.reject(new DomainError("NOT_FOUND", RELAY_TEXT.errBoardNotFound))
    if (b.refreshing) return b.refreshing
    if (b.lastRefresh && Date.now() - b.lastRefreshAt < refreshWindowMs) return Promise.resolve(b.lastRefresh)
    b.lastRefreshAt = Date.now()
    const p = pollNow(b).then((r) => {
      b.lastRefresh = r
      b.lastRefreshAt = Date.now()
      if (b.enabled && !b.disposed) schedule(b, b.online === false ? cfg.offlinePollMs : cfg.pollMs)
      return r
    }).finally(() => { b.refreshing = null })
    b.refreshing = p
    return p
  }

  async function test(input: BoardConnectionInput, actor: ActorRef): Promise<DetectResultDTO[]> {
    let results: DetectResultDTO[]
    if (input.driver === "simulated") {
      results = cfg.simulate ? [{
        driver: "simulated", confidence: "high", host: input.host, httpPort: input.httpPort, tcpPort: input.tcpPort,
        model: null, moduleId: null, relayCount: null, hostname: null, mac: null, firmware: null, authRequired: false,
        options: {}, evidence: [RELAY_TEXT.simEvidence],
      }] : []
    } else {
      const tcpPort = input.driver ? effectiveTcpPort(input.driver, input.tcpPort) : input.tcpPort
      const all = await withOpSignal(life.signal, 15_000, (signal) =>
        drivers.autodetect(input.host, { httpPort: input.httpPort, tcpPort }, { signal, timeoutMs: cfg.timeoutMs }))
      results = input.driver ? [...all.filter((r) => r.driver === input.driver), ...all.filter((r) => r.driver !== input.driver)] : all
    }
    deps.audit.record({
      actor, action: "board.test", outcome: "ok", target: { type: "board", id: null, name: input.host },
      detail: { host: input.host, httpPort: input.httpPort, tcpPort: input.tcpPort, driver: input.driver ?? null, found: results.map((r) => r.driver) },
    })
    return results
  }

  // ---------------------------------------------------------------- public

  return {
    reload,
    boardRuntime: (id) => { const b = boards.get(id); return b ? runtimeOf(b) : null },
    capabilities: (id) => { const b = boards.get(id); return b ? caps(b) : null },
    channelStates: (equipmentId) => (byEquipment.get(equipmentId) ?? []).map(channelDTO),
    set,
    pulse,
    refresh,
    test,
    knownBoards: () => [...boards.values()].map((b) => ({ id: b.ref.id, name: b.ref.name, host: b.ref.host, httpPort: b.ref.httpPort, mac: b.mac })),
    activeTimers: () => [...boards.values()].filter((b) => b.hasTimer).length,
    async stop() {
      stopped = true
      for (const b of boards.values()) unschedule(b)
      const settle = (ms: number) => Promise.race([
        Promise.all([...boards.values()].map((b) => b.tail)),
        new Promise((r) => setTimeout(r, ms).unref()),
      ])
      // Wait for in-flight commands (at most 2 s), then abort the rest.
      await settle(2000)
      life.abort()
      // An emulated pulse cut short by the abort still toggles its relay back (with its own timeout): wait for that
      // restore, bounded, so the process never exits with the relay left changed.
      await settle(cfg.timeoutMs * 2 + 500)
    },
  }
}
