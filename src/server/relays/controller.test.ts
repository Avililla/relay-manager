import v8 from "node:v8"
import vm from "node:vm"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import type { DriverCapabilitiesDTO } from "@/lib/contracts/relays"
import type { DriverId } from "@/lib/contracts/enums"
import { createNullLogger } from "@/server/log"
import type { UserActor } from "@/server/runtime/types"
import { createTestDb, fakeAudit, fakeBus, fakeReservations, testConfig, type TestDb } from "../../../test/helpers"
import { createSimulator, type Simulator } from "../../../scripts/sim/devantech-sim.mjs"
import { createRelayController, type RelayControllerImpl, type TimerApi } from "./controller"
import { createDriverRegistry, type DriverRegistry } from "./registry"
import { defaultTransports } from "./transport"
import { RelayDriverError, type BoardRef, type RelayDriver } from "./types"

// ------------------------------------------------------------------ fakes

interface FakeDriver extends RelayDriver {
  states: boolean[]; fail: RelayDriverError | null; stuck: Set<number>; delayMs: number
  reads: number; active: number; maxActive: number; log: string[]
}
function fakeDriver(n = 4, caps: Partial<DriverCapabilitiesDTO> = {}): FakeDriver {
  const d: FakeDriver = {
    id: "simulated", label: "Falsa",
    states: new Array(n).fill(false), fail: null, stuck: new Set(), delayMs: 0, reads: 0, active: 0, maxActive: 0, log: [],
    capabilities: () => ({ absoluteSet: true, toggle: "emulated", pulse: "native", pulseMs: { min: 100, max: 1000, step: 1 }, maxRelays: 32, ...caps }),
    detect: async () => null,
    async readState() { return run("read", () => { d.reads++; return [...d.states] }) },
    async setRelay(_b: BoardRef, ch: number, on: boolean) { return run(`set ${ch} ${on}`, () => { if (!d.stuck.has(ch)) d.states[ch - 1] = on }) },
    async pulse(_b: BoardRef, ch: number, ms: number) { return run(`pulse ${ch} ${ms}`, () => {}) },
  }
  async function run<T>(what: string, fn: () => T): Promise<T> {
    d.active++; d.maxActive = Math.max(d.maxActive, d.active); d.log.push(`start ${what}`)
    try {
      if (d.delayMs) await new Promise((r) => setTimeout(r, d.delayMs))
      if (d.fail) throw d.fail
      return fn()
    } finally { d.active--; d.log.push(`end ${what}`) }
  }
  return d
}
const registryOf = (d: RelayDriver): DriverRegistry => ({ get: () => d, autodetect: async () => [] })

/** Manual timers: nothing fires until the test calls fire(). */
function manualTimers(): TimerApi & { pending: Map<number, { fn: () => void; ms: number }>; delays: number[]; fire(): void } {
  let seq = 0
  const pending = new Map<number, { fn: () => void; ms: number }>()
  const delays: number[] = []
  return {
    pending, delays,
    set(fn, ms) { const id = ++seq; pending.set(id, { fn, ms }); delays.push(ms); return id },
    clear(h) { pending.delete(h as number) },
    fire() { const all = [...pending.values()]; pending.clear(); for (const p of all) p.fn() },
  }
}

// ------------------------------------------------------------------ fixture

let db: TestDb
beforeAll(async () => { db = await createTestDb() })
afterAll(async () => { await db.cleanup() })

const holder: UserActor = { kind: "user", id: "u-holder", name: "operador", ip: "10.0.0.5" }
let bus: ReturnType<typeof fakeBus>
let audit: ReturnType<typeof fakeAudit>
let reservations: ReturnType<typeof fakeReservations>
let ctl: RelayControllerImpl | null = null
let eqId = ""
let otherEqId = ""

async function seed(o: { driver?: DriverId; host?: string; tcpPort?: number | null; enabled?: boolean; relayCount?: number } = {}) {
  const eq = await db.prisma.equipment.create({ data: { name: `Equipo A #${Math.random().toString(36).slice(2, 8)}` } })
  const other = await db.prisma.equipment.create({ data: { name: `Equipo C #${Math.random().toString(36).slice(2, 8)}` } })
  const b = await db.prisma.relayBoard.create({
    data: {
      name: `Placa ${Math.random().toString(36).slice(2, 8)}`, driver: o.driver ?? "simulated", host: o.host ?? "127.0.0.1",
      httpPort: 10000 + Math.floor(Math.random() * 50000), tcpPort: o.tcpPort ?? null, relayCount: o.relayCount ?? 4,
      enabled: o.enabled ?? true, options: {},
    },
  })
  const power = await db.prisma.relayChannel.create({ data: { equipmentId: eq.id, boardId: b.id, channel: 1, position: 0, key: "POWER", label: "Alimentación", purpose: "power", requireConfirm: true } })
  const reset = await db.prisma.relayChannel.create({ data: { equipmentId: eq.id, boardId: b.id, channel: 2, position: 1, key: "RESET", label: "Reinicio", purpose: "reset" } })
  const aux = await db.prisma.relayChannel.create({ data: { equipmentId: other.id, boardId: b.id, channel: 3, position: 0, label: "Auxiliar" } })
  eqId = eq.id
  otherEqId = other.id
  return { board: b, power, reset, aux }
}

function make(drivers: DriverRegistry, over: Partial<Parameters<typeof createRelayController>[0]> = {}): RelayControllerImpl {
  ctl = createRelayController({
    prisma: db.prisma, bus, audit, reservations, log: createNullLogger(), config: testConfig(), drivers,
    verify: { attempts: 3, intervalMs: 5 }, refreshWindowMs: 0, ...over,
  })
  return ctl
}

beforeEach(async () => {
  await db.prisma.relayChannel.deleteMany()
  await db.prisma.relayBoard.deleteMany()
  await db.prisma.equipment.deleteMany()
  bus = fakeBus()
  audit = fakeAudit()
  reservations = fakeReservations()
})
afterEach(async () => { await ctl?.stop(); ctl = null })

const relayStateEvents = () => bus.events.filter((e) => e.event.type === "relay.state")
const boardStatusEvents = () => bus.events.filter((e) => e.event.type === "board.status")

// ------------------------------------------------------------------ tests

describe("poll loop", () => {
  it("runs no timer with 0 boards, or with only disabled boards; reload() starts the loop again", async () => {
    const c = make(registryOf(fakeDriver()))
    await c.reload()
    expect(c.activeTimers()).toBe(0)
    const { board } = await seed({ enabled: false })
    await c.reload()
    expect(c.activeTimers()).toBe(0)
    await db.prisma.relayBoard.update({ where: { id: board.id }, data: { enabled: true } })
    await c.reload()
    expect(c.activeTimers()).toBe(1)
    await db.prisma.relayBoard.delete({ where: { id: board.id } })
    await c.reload()
    expect(c.activeTimers()).toBe(0)
  })

  it("publishes board.status and relay.state (per equipment) only when something changes, and persists it", async () => {
    const d = fakeDriver()
    const timers = manualTimers()
    const { board, power, reset, aux } = await seed()
    const c = make(registryOf(d), { timers })
    await c.reload()
    expect(c.boardRuntime(board.id)).toMatchObject({ online: null, states: [null, null, null, null], stale: true })
    timers.fire()
    await vi.waitFor(() => expect(c.boardRuntime(board.id)?.online).toBe(true))
    expect(boardStatusEvents()).toHaveLength(1)
    expect(boardStatusEvents()[0]?.audience).toEqual({ kind: "admins" })
    const rs = relayStateEvents()
    expect(rs.map((e) => e.audience)).toEqual(expect.arrayContaining([{ kind: "equipment", equipmentId: eqId }, { kind: "equipment", equipmentId: otherEqId }]))
    const mine = rs.find((e) => e.audience.kind === "equipment" && e.audience.equipmentId === eqId)?.event
    expect(mine).toMatchObject({ type: "relay.state", equipmentId: eqId, channels: [
      { channelId: power.id, on: false, stale: false }, { channelId: reset.id, on: false, stale: false }] })
    expect(c.channelStates(otherEqId)).toEqual([{ channelId: aux.id, on: false, stale: false }])
    const row = await db.prisma.relayBoard.findUniqueOrThrow({ where: { id: board.id } })
    expect(row).toMatchObject({ online: true, relayState: "0000", lastError: null })

    const before = bus.events.length
    await c.refresh(board.id)                 // same state: no event
    expect(bus.events.length).toBe(before)
    d.states[1] = true                        // changed on the board (e.g. front panel)
    await c.refresh(board.id)
    expect(bus.events.length).toBeGreaterThan(before)
    expect(c.channelStates(eqId)).toEqual([{ channelId: power.id, on: false, stale: false }, { channelId: reset.id, on: true, stale: false }])
    expect((await db.prisma.relayBoard.findUniqueOrThrow({ where: { id: board.id } })).relayState).toBe("0100")
  })

  it("backs off to RM_RELAY_OFFLINE_POLL_MS after a failure, marks states stale, and returns to RM_RELAY_POLL_MS", async () => {
    const d = fakeDriver()
    const timers = manualTimers()
    const { board } = await seed()
    const c = make(registryOf(d), { timers })
    await c.reload()
    expect(timers.delays).toEqual([0])
    d.fail = new RelayDriverError("La placa 127.0.0.1 no ha respondido a tiempo", "timeout")
    timers.fire()
    await vi.waitFor(() => expect(c.boardRuntime(board.id)?.online).toBe(false))
    await vi.waitFor(() => expect(timers.delays.at(-1)).toBe(15000))
    expect(c.boardRuntime(board.id)).toMatchObject({ online: false, stale: true, lastError: "La placa 127.0.0.1 no ha respondido a tiempo" })
    expect(c.channelStates(eqId).every((s) => s.stale)).toBe(true)
    const last = relayStateEvents().at(-1)?.event
    expect(last?.type === "relay.state" && last.channels.every((ch) => ch.stale)).toBe(true)
    expect((await db.prisma.relayBoard.findUniqueOrThrow({ where: { id: board.id } })).online).toBe(false)
    d.fail = null
    timers.fire()
    await vi.waitFor(() => expect(c.boardRuntime(board.id)?.online).toBe(true))
    await vi.waitFor(() => expect(timers.delays.at(-1)).toBe(5000))
    expect(c.activeTimers()).toBe(1)
  })

  it("coalesces refreshes to one poll per board per 2 s", async () => {
    const d = fakeDriver()
    const { board } = await seed()
    const c = make(registryOf(d), { timers: manualTimers(), refreshWindowMs: 2000 })
    await c.reload()
    const [a, b] = await Promise.all([c.refresh(board.id), c.refresh(board.id)])
    await c.refresh(board.id)
    expect(d.reads).toBe(1)
    expect(a).toEqual(b)
    await expect(c.refresh("nope")).rejects.toMatchObject({ code: "NOT_FOUND" })
  })

  it("does not retain memory per poll (regression: AbortSignal.any with the lifecycle signal leaked ~1.7 KB/poll)", async () => {
    v8.setFlagsFromString("--expose-gc")
    const gc = vm.runInNewContext("gc") as () => void
    const N = 40_000
    const states = [false, false, false, false]
    // A bare driver: no per-call bookkeeping that would itself grow the heap.
    const driver: RelayDriver = {
      id: "simulated", label: "Mínima",
      capabilities: () => ({ absoluteSet: true, toggle: "emulated", pulse: "native", pulseMs: { min: 100, max: 1000, step: 1 }, maxRelays: 32 }),
      detect: async () => null,
      readState: async (_b, signal) => { if (signal.aborted) throw new Error("aborted"); return states },
      setRelay: async () => undefined,
      pulse: async () => undefined,
    }
    let polls = 0
    let done: () => void = () => undefined
    const finished = new Promise<void>((r) => { done = r })
    const timers: TimerApi = {
      set: (fn) => {
        if (polls >= N) { done(); return null }
        return setImmediate(() => { polls++; fn() })
      },
      clear: (h) => { if (h) clearImmediate(h as NodeJS.Immediate) },
    }
    await seed()
    const c = make(registryOf(driver), { timers })
    await c.reload() // first poll: online + persisted, then the loop only reads
    // Warm up by poll count, not wall time: a fast machine runs most of N polls in a fixed 200 ms.
    while (polls < 2_000) await new Promise((r) => setImmediate(r))
    gc(); gc()
    const p0 = polls
    const m0 = process.memoryUsage().heapUsed
    await finished
    gc(); gc()
    const perPoll = (process.memoryUsage().heapUsed - m0) / (polls - p0)
    expect(polls - p0).toBeGreaterThan(N / 2)
    expect(perPoll).toBeLessThan(200) // leaking: ~1500 B/poll; fixed: ~0
  }, 60_000)
})

describe("set and pulse", () => {
  it("serialises concurrent set/poll/pulse on one board through the mutex", async () => {
    const d = fakeDriver()
    d.delayMs = 15
    const { board, power, reset } = await seed()
    reservations.holders.set(eqId, holder.id)
    const c = make(registryOf(d), { timers: manualTimers() })
    await c.reload()
    await Promise.all([
      c.set(eqId, power.id, true, holder), c.refresh(board.id), c.set(eqId, reset.id, true, holder),
      c.pulse(eqId, reset.id, 200, holder), c.refresh(board.id),
    ])
    await vi.waitFor(() => expect(d.active).toBe(0))   // the post-pulse poll also goes through the mutex
    expect(d.maxActive).toBe(1)
    expect(d.log.filter((l) => l.startsWith("start")).length).toBe(d.log.filter((l) => l.startsWith("end")).length)
  })

  it("the holder sets a relay: verify, state, event, audit relay.set and reservation touch", async () => {
    const d = fakeDriver()
    const { board, power } = await seed()
    reservations.holders.set(eqId, holder.id)
    const touch = vi.spyOn(reservations, "touch")
    const c = make(registryOf(d), { timers: manualTimers() })
    await c.reload()
    const r = await c.set(eqId, power.id, true, holder)
    expect(r).toEqual({ channelId: power.id, on: true, stale: false })
    expect(d.states[0]).toBe(true)
    const mine = relayStateEvents().filter((e) => e.audience.kind === "equipment" && e.audience.equipmentId === eqId)
    expect(mine.at(-1)?.event).toMatchObject({ equipmentId: eqId, channels: expect.arrayContaining([{ channelId: power.id, on: true, stale: false }]) })
    const a = audit.inputs.find((i) => i.action === "relay.set")
    expect(a).toMatchObject({ actor: holder, outcome: "ok", equipment: { id: eqId }, target: { type: "relay", id: power.id, name: "Alimentación" },
      detail: { boardId: board.id, channel: 1, before: null, after: true, verified: true } })
    expect(touch).toHaveBeenCalledWith(eqId, holder.id, "relay")
    expect((await db.prisma.relayBoard.findUniqueOrThrow({ where: { id: board.id } })).relayState).toBe("1000")
  })

  it("refuses a non-holder with NOT_HOLDER and never reaches the driver", async () => {
    const d = fakeDriver()
    const { power } = await seed()
    const c = make(registryOf(d), { timers: manualTimers() })
    await c.reload()
    await expect(c.set(eqId, power.id, true, holder)).rejects.toMatchObject({ name: "DomainError", code: "NOT_HOLDER" })
    await expect(c.pulse(eqId, power.id, 200, holder)).rejects.toMatchObject({ code: "NOT_HOLDER" })
    expect(d.log).toEqual([])
  })

  it("NOT_FOUND when the channel does not belong to the equipment", async () => {
    const { aux } = await seed()
    reservations.holders.set(eqId, holder.id)
    const c = make(registryOf(fakeDriver()), { timers: manualTimers() })
    await c.reload()
    await expect(c.set(eqId, aux.id, true, holder)).rejects.toMatchObject({ code: "NOT_FOUND" })
    await expect(c.set(eqId, "doesnotexist", true, holder)).rejects.toMatchObject({ code: "NOT_FOUND" })
  })

  it("a relay that does not follow the command → DRIVER_ERROR with the pulse/equation message, audited as error", async () => {
    const d = fakeDriver()
    d.stuck.add(1)
    const { power } = await seed()
    reservations.holders.set(eqId, holder.id)
    const c = make(registryOf(d), { timers: manualTimers() })
    await c.reload()
    await expect(c.set(eqId, power.id, true, holder)).rejects.toMatchObject({
      code: "DRIVER_ERROR",
      message: "El relé Alimentación no cambió de estado: puede estar configurado como pulso o gobernado por una ecuación en la placa",
    })
    expect(audit.inputs.find((i) => i.action === "relay.set")).toMatchObject({ outcome: "error", detail: { verified: false, after: false } })
    expect(d.reads).toBe(3)
  })

  it("maps a driver failure to DRIVER_ERROR and marks the board offline", async () => {
    const d = fakeDriver()
    const { board, power } = await seed()
    reservations.holders.set(eqId, holder.id)
    const c = make(registryOf(d), { timers: manualTimers() })
    await c.reload()
    d.fail = new RelayDriverError("No se puede conectar con 127.0.0.1:17123 (ECONNREFUSED)", "unreachable")
    await expect(c.set(eqId, power.id, true, holder)).rejects.toMatchObject({ code: "DRIVER_ERROR", message: expect.stringContaining("ECONNREFUSED") })
    expect(c.boardRuntime(board.id)?.online).toBe(false)
    expect(audit.inputs.find((i) => i.action === "relay.set")?.outcome).toBe("error")
  })

  it("a timeout or a plain network error on set also marks the board offline", async () => {
    const d = fakeDriver()
    const { board, power } = await seed()
    reservations.holders.set(eqId, holder.id)
    const c = make(registryOf(d), { timers: manualTimers() })
    await c.reload()
    await c.refresh(board.id)
    d.fail = new RelayDriverError("La placa 127.0.0.1 no ha respondido a tiempo", "timeout")
    await expect(c.set(eqId, power.id, true, holder)).rejects.toMatchObject({ code: "DRIVER_ERROR" })
    expect(c.boardRuntime(board.id)).toMatchObject({ online: false, stale: true })
    d.fail = null
    await c.refresh(board.id)
    d.fail = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) as unknown as RelayDriverError
    await expect(c.set(eqId, power.id, true, holder)).rejects.toMatchObject({ code: "DRIVER_ERROR" })
    expect(c.boardRuntime(board.id)).toMatchObject({ online: false, lastError: "read ECONNRESET" })
  })

  it.each(["auth", "config", "nack", "protocol", "unsupported"] as const)(
    "a %s refusal on set/pulse is audited and returned as DRIVER_ERROR, but the reachable board stays online", async (kind) => {
      const d = fakeDriver()
      const { board, power, reset } = await seed()
      reservations.holders.set(eqId, holder.id)
      const c = make(registryOf(d), { timers: manualTimers() })
      await c.reload()
      await c.refresh(board.id)
      expect(c.boardRuntime(board.id)).toMatchObject({ online: true, stale: false, lastError: null })
      const eventsBefore = bus.events.length
      d.fail = new RelayDriverError("Contraseña TCP incorrecta", kind)
      await expect(c.set(eqId, power.id, true, holder)).rejects.toMatchObject({ code: "DRIVER_ERROR", message: expect.stringContaining("Contraseña TCP incorrecta") })
      await expect(c.pulse(eqId, reset.id, 300, holder)).rejects.toMatchObject({ code: "DRIVER_ERROR" })
      expect(c.boardRuntime(board.id)).toMatchObject({ online: true, stale: false, lastError: null })
      expect(c.channelStates(eqId).every((s) => !s.stale)).toBe(true)
      expect(bus.events.length).toBe(eventsBefore) // no board.status offline, no stale relay.state
      expect(audit.inputs.find((i) => i.action === "relay.set")).toMatchObject({ outcome: "error", detail: { error: "Contraseña TCP incorrecta" } })
      expect(audit.inputs.find((i) => i.action === "relay.pulse")).toMatchObject({ outcome: "error", detail: { error: "Contraseña TCP incorrecta" } })
      expect((await db.prisma.relayBoard.findUniqueOrThrow({ where: { id: board.id } })).online).toBe(true)
    })

  it("pulse: ms off the driver step → VALIDATION (the board would round it); on the step → sent as audited", async () => {
    const d = fakeDriver(4, { pulseMs: { min: 100, max: 25500, step: 100 } })
    const { reset } = await seed()
    reservations.holders.set(eqId, holder.id)
    const c = make(registryOf(d), { timers: manualTimers() })
    await c.reload()
    await expect(c.pulse(eqId, reset.id, 150, holder)).rejects.toMatchObject({
      code: "VALIDATION", message: "La duración del pulso debe estar entre 100 y 25500 ms, en pasos de 100 ms",
      fieldErrors: { ms: ["La duración del pulso debe estar entre 100 y 25500 ms, en pasos de 100 ms"] },
    })
    expect(d.log.some((l) => l.startsWith("start pulse"))).toBe(false)
    await c.pulse(eqId, reset.id, 200, holder)
    expect(d.log).toContain("start pulse 2 200")
    expect(audit.inputs.find((i) => i.action === "relay.pulse")).toMatchObject({ outcome: "ok", detail: { ms: 200 } })
  })

  it("pulse: ms outside the driver range → VALIDATION; in range → driver pulse, audit relay.pulse", async () => {
    const d = fakeDriver()
    const { reset } = await seed()
    reservations.holders.set(eqId, holder.id)
    const c = make(registryOf(d), { timers: manualTimers() })
    await c.reload()
    await expect(c.pulse(eqId, reset.id, 50, holder)).rejects.toMatchObject({ code: "VALIDATION", message: "La duración del pulso debe estar entre 100 y 1000 ms" })
    await expect(c.pulse(eqId, reset.id, 5000, holder)).rejects.toMatchObject({ code: "VALIDATION" })
    await c.pulse(eqId, reset.id, 300, holder)
    expect(d.log).toContain("start pulse 2 300")
    expect(audit.inputs.find((i) => i.action === "relay.pulse")).toMatchObject({ outcome: "ok", detail: { channel: 2, ms: 300, emulated: false } })
  })

  it("re-checks the reservation inside the board mutex: a queued set/pulse fails NOT_HOLDER once the holder lost it", async () => {
    const d = fakeDriver()
    const { board, power, reset } = await seed()
    reservations.holders.set(eqId, holder.id)
    const touch = vi.spyOn(reservations, "touch")
    const isHolder = vi.spyOn(reservations, "isHolder")
    const c = make(registryOf(d), { timers: manualTimers() })
    await c.reload()
    let open: () => void = () => undefined
    const gate = new Promise<void>((r) => { open = r })
    const read = d.readState.bind(d)
    d.readState = async (b, s) => { await gate; return read(b, s) }
    const slow = c.refresh(board.id)                          // holds the mutex until the gate opens
    const queuedSet = c.set(eqId, power.id, true, holder)     // passes the first check, then waits for the lock
    const queuedPulse = c.pulse(eqId, reset.id, 200, holder)
    await vi.waitFor(() => expect(isHolder).toHaveBeenCalledTimes(2))
    reservations.holders.delete(eqId)                         // expired / force-released meanwhile
    open()
    await slow
    await expect(queuedSet).rejects.toMatchObject({ name: "DomainError", code: "NOT_HOLDER" })
    await expect(queuedPulse).rejects.toMatchObject({ name: "DomainError", code: "NOT_HOLDER" })
    expect(d.log.some((l) => l.startsWith("start set") || l.startsWith("start pulse"))).toBe(false)
    expect(touch).not.toHaveBeenCalled()
    expect(c.boardRuntime(board.id)).toMatchObject({ online: true, lastError: null })
    // no driver-error audit for a refusal that never reached the board
    expect(audit.inputs.filter((i) => i.action === "relay.set" || i.action === "relay.pulse")).toEqual([])
  })

  it("stop() waits for an interrupted emulated pulse to restore the relay, and audits it as interrumpido", async () => {
    const d = fakeDriver(4, { pulse: "emulated", pulseMs: { min: 100, max: 60000, step: 100 } })
    const restoreLog: string[] = []
    d.pulse = async (_b, ch, ms, signal) => {
      d.log.push(`start pulse ${ch} ${ms}`)
      d.states[ch - 1] = !d.states[ch - 1]
      try { await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, ms)
        signal.addEventListener("abort", () => { clearTimeout(t); reject(new Error("aborted")) }, { once: true })
      }) } catch { /* restore below, like ds-http */ }
      await new Promise((r) => setTimeout(r, 150))            // the restoring toggle takes a while
      d.states[ch - 1] = !d.states[ch - 1]
      restoreLog.push(`restored ${ch}`)
    }
    const { reset } = await seed()
    reservations.holders.set(eqId, holder.id)
    const touch = vi.spyOn(reservations, "touch")
    const c = make(registryOf(d), { timers: manualTimers() })
    ctl = null // stopped by the test itself
    await c.reload()
    const p = c.pulse(eqId, reset.id, 20_000, holder)
    const outcome = p.then(() => "ok", (e: unknown) => e)
    await vi.waitFor(() => expect(d.log).toContain("start pulse 2 20000"))
    await c.stop()
    expect(restoreLog).toEqual(["restored 2"])                // stop() returned only after the restore
    expect(d.states[1]).toBe(false)
    expect(await outcome).toMatchObject({ name: "DomainError", code: "DRIVER_ERROR" })
    expect(audit.inputs.find((i) => i.action === "relay.pulse")).toMatchObject({
      outcome: "error", detail: { channel: 2, ms: 20_000, emulated: true, error: "interrumpido" } })
    expect(touch).not.toHaveBeenCalled()
  }, 10_000)

  it("a disabled board refuses commands and reports its channels as stale", async () => {
    const { power } = await seed({ enabled: false })
    reservations.holders.set(eqId, holder.id)
    const c = make(registryOf(fakeDriver()), { timers: manualTimers() })
    await c.reload()
    await expect(c.set(eqId, power.id, true, holder)).rejects.toMatchObject({ code: "DRIVER_ERROR", message: expect.stringContaining("desactivada") })
    expect(c.channelStates(eqId).every((s) => s.on === null && s.stale)).toBe(true)
  })
})

describe("with real drivers and the simulator", () => {
  let s: Simulator
  beforeAll(async () => { s = await createSimulator({ log: false, model: "dS378", ascii: 0 }) })
  afterAll(async () => { await s.stop() })

  it("ds-ascii: the holder's set reaches the board and the simulator state matches", async () => {
    const { board, power } = await seed({ driver: "devantech-ds-ascii", host: s.host, tcpPort: s.ports.ascii, relayCount: 8 })
    reservations.holders.set(eqId, holder.id)
    const c = make(createDriverRegistry({ transports: defaultTransports, timeoutMs: 800, log: createNullLogger() }), { timers: manualTimers(), verify: { attempts: 5, intervalMs: 20 } })
    await c.reload()
    await c.set(eqId, power.id, true, holder)
    expect(s.state()[0]).toBe(true)
    expect(c.boardRuntime(board.id)).toMatchObject({ online: true, stale: false, capabilities: { absoluteSet: true, pulse: "native" } })
    await c.set(eqId, power.id, false, holder)
    expect(s.state()[0]).toBe(false)
  })

  it("simulated driver with pulseChannels → DRIVER_ERROR (the nack path)", async () => {
    const { board, power } = await seed()
    await db.prisma.relayBoard.update({ where: { id: board.id }, data: { options: { sim: { pulseChannels: [1] } } } })
    reservations.holders.set(eqId, holder.id)
    const c = make(createDriverRegistry({ transports: defaultTransports, timeoutMs: 800, log: createNullLogger() }), { timers: manualTimers(), verify: { attempts: 3, intervalMs: 60 } })
    await c.reload()
    await expect(c.set(eqId, power.id, true, holder)).rejects.toMatchObject({ code: "DRIVER_ERROR", message: expect.stringContaining("no cambió de estado") })
  })

  it("test() runs autodetect without touching the DB and audits board.test", async () => {
    const c = make(createDriverRegistry({ transports: defaultTransports, timeoutMs: 800, log: createNullLogger() }), { timers: manualTimers() })
    await c.reload()
    const actor = { kind: "user" as const, id: "admin1", name: "admin", ip: "10.0.0.1" }
    const res = await c.test({ host: s.host, httpPort: s.ports.http ?? 80, tcpPort: s.ports.ascii, username: null, password: "no-se-registra" }, actor)
    expect(res[0]).toMatchObject({ driver: "devantech-ds-ascii", model: "dS378" })
    const a = audit.inputs.find((i) => i.action === "board.test")
    expect(a).toMatchObject({ actor, outcome: "ok", target: { type: "board", name: `${s.host}` } })
    expect(JSON.stringify(a)).not.toContain("no-se-registra")
    expect(await db.prisma.relayBoard.count()).toBe(0)
  })
})
