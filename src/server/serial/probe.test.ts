import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { SerialPortMock } from "serialport"
import { isDomainError } from "@/server/errors"
import { createNullLogger } from "@/server/log"
import { fakeAudit } from "../../../test/helpers"
import { createPortOpener } from "./port-factory"
import { createProbeService } from "./probe"
import { FakeDiscovery, virtualDevice } from "./testing/fakes"

interface MockStream { port?: { recording: Buffer } }

let streams: MockStream[] = []
beforeEach(() => {
  SerialPortMock.binding.reset()
  streams = []
})
afterEach(() => SerialPortMock.binding.reset())

const actor = { kind: "user" as const, id: "a1", name: "admin" }

function setup(o: { held?: Record<string, string>; bound?: string[]; allowPoke?: boolean; hang?: string[] } = {}) {
  const devs = ["ttyV0", "ttyV1", "ttyV2", "ttyV3"].map((n) => virtualDevice(n))
  const discovery = new FakeDiscovery(devs)
  const audit = fakeAudit()
  const opened: string[] = []
  const base = createPortOpener(SerialPortMock as unknown as Parameters<typeof createPortOpener>[0], { onStream: (s) => streams.push(s as MockStream) })
  const probe = createProbeService({
    discovery,
    openPort: async (opts) => {
      opened.push(opts.path)
      return o.hang?.includes(opts.path) ? new Promise<never>(() => {}) : base(opts)
    },
    audit,
    log: createNullLogger(),
    held: { history: (key) => (o.held?.[key] !== undefined ? Buffer.from(o.held[key]) : null), isBound: (key) => o.bound?.includes(key) ?? false },
    allowPoke: () => o.allowPoke ?? true,
    usage: { busy: new Set<string>() },
    timings: { pokeListenMs: 60, pokeAfterMs: 120, bootExtraMs: 150 },
    openTimeoutMs: 150,
  })
  return { devs, probe, audit, opened }
}

const recorded = () => Buffer.concat(streams.map((s) => s.port?.recording ?? Buffer.alloc(0))).toString("latin1")

describe("identify (passive)", () => {
  it("never writes, classifies, closes; audits console.probe", async () => {
    const { devs, probe, audit } = setup()
    SerialPortMock.binding.createPort(devs[0].openPath, { record: true, readyData: Buffer.from("\r\nPetaLinux 2022.2 equipo-uart1 ttyPS0\r\n\r\nequipo-uart1 login: ") })
    SerialPortMock.binding.createPort(devs[1].openPath, { record: true })
    const [a, b] = await probe.identify([devs[0].stableKey, devs[1].stableKey], { baudRate: 115200, listenMs: 100 }, actor)
    expect(a).toMatchObject({ stableKey: devs[0].stableKey, devNode: devs[0].devNode, state: "login", hostname: "equipo-uart1", openByApp: false, poked: false, error: null })
    expect(a.sample).toContain("equipo-uart1 login:")
    expect(b).toMatchObject({ state: "silent", poked: false })
    expect(recorded()).toBe("")
    expect(audit.inputs.find((i) => i.action === "console.probe")?.detail).toEqual({ stableKeys: [devs[0].stableKey, devs[1].stableKey], results: ["login", "silent"] })
  })

  it("a port the app holds is classified from its buffer and never reopened", async () => {
    const { devs, probe, opened } = setup({ held: { "virtual:/run/relay-manager/sim/ttyV2": "\r\nroot@equipo-uart0:~# " } })
    const [r] = await probe.identify([devs[2].stableKey], { baudRate: 115200, listenMs: 100 }, actor)
    expect(r).toMatchObject({ state: "shell", hostname: "equipo-uart0", openByApp: true, poked: false })
    expect(opened).toEqual([])
  })

  it("busy-other when another program holds the lock", async () => {
    const { devs, probe } = setup()
    SerialPortMock.binding.createPort(devs[0].openPath, { record: true })
    const holder = new SerialPortMock({ path: devs[0].openPath, baudRate: 115200, lock: true })
    await new Promise<void>((r) => holder.on("open", () => r()))
    const [r] = await probe.identify([devs[0].stableKey], { baudRate: 115200, listenMs: 100 }, actor)
    expect(r.state).toBe("busy-other")
    expect(r.error).toMatch(/locked|lock/i)
    await new Promise<void>((res) => holder.close(() => res()))
  })

  it("unknown key → missing (a path is never derived from the key)", async () => {
    const { probe, opened } = setup()
    const [r] = await probe.identify(["virtual:/etc/passwd"], { baudRate: 115200, listenMs: 100 }, actor)
    expect(r).toMatchObject({ state: "missing", devNode: null })
    expect(opened).toEqual([])
  })

  it("keeps listening while Linux boots", async () => {
    const { devs, probe } = setup()
    SerialPortMock.binding.createPort(devs[3].openPath, { record: true, readyData: Buffer.from("[    0.000000] Booting Linux on physical CPU 0x0\r\n") })
    const [r] = await probe.identify([devs[3].stableKey], { baudRate: 115200, listenMs: 100 }, actor)
    expect(r.state).toBe("linux-booting")
    expect(r.ms).toBeGreaterThanOrEqual(240)
    expect(recorded()).toBe("")
  })
})

describe("hung opens", () => {
  it("identify and poke give up after the open deadline with state error", async () => {
    const { devs, probe } = setup({ hang: [virtualDevice("ttyV3").openPath] })
    SerialPortMock.binding.createPort(devs[0].openPath, { record: true })
    const t0 = Date.now()
    const [hung, ok] = await probe.identify([devs[3].stableKey, devs[0].stableKey], { baudRate: 115200, listenMs: 50 }, actor)
    expect(Date.now() - t0).toBeLessThan(1000)
    expect(hung).toMatchObject({ state: "error", error: "Tiempo de espera agotado al abrir el puerto" })
    expect(ok.state).toBe("silent")
    expect(await probe.poke(devs[3].stableKey, { baudRate: 115200 }, actor)).toMatchObject({ state: "error", poked: false })
  })
})

describe("poke (explicit carriage return)", () => {
  it("writes exactly one \\r to a silent free port", async () => {
    const { devs, probe, audit } = setup()
    SerialPortMock.binding.createPort(devs[0].openPath, { record: true })
    const r = await probe.poke(devs[0].stableKey, { baudRate: 115200 }, actor)
    expect(r).toMatchObject({ poked: true, state: "silent" })
    expect(recorded()).toBe("\r")
    expect(audit.inputs.find((i) => i.action === "console.poke")).toMatchObject({ outcome: "ok" })
  })

  it("refuses during a U-Boot countdown and writes nothing", async () => {
    const { devs, probe, audit } = setup()
    SerialPortMock.binding.createPort(devs[1].openPath, { record: true, readyData: Buffer.from("U-Boot 2022.01\r\nHit any key to stop autoboot: 3 ") })
    const err = await probe.poke(devs[1].stableKey, { baudRate: 115200 }, actor).then(() => null, (e: unknown) => e)
    expect(isDomainError(err) && err.code).toBe("CONFLICT")
    expect(isDomainError(err) && err.message).toBe("Cuenta atrás de U-Boot en curso: no se envía nada")
    expect(recorded()).toBe("")
    expect(audit.inputs.find((i) => i.action === "console.poke")).toMatchObject({ outcome: "denied" })
  })

  it("refuses bound ports, ports the app holds, unknown ports and a disabled policy", async () => {
    const code = (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => (isDomainError(e) ? e.code : "?"))
    const bound = setup({ bound: ["virtual:/run/relay-manager/sim/ttyV0"] })
    expect(await code(bound.probe.poke(bound.devs[0].stableKey, { baudRate: 115200 }, actor))).toBe("DEVICE_ALREADY_BOUND")
    const held = setup({ held: { "virtual:/run/relay-manager/sim/ttyV1": "x" } })
    expect(await code(held.probe.poke(held.devs[1].stableKey, { baudRate: 115200 }, actor))).toBe("DEVICE_BUSY")
    expect(await code(held.probe.poke("virtual:/nope", { baudRate: 115200 }, actor))).toBe("DEVICE_NOT_FOUND")
    const off = setup({ allowPoke: false })
    expect(await code(off.probe.poke(off.devs[2].stableKey, { baudRate: 115200 }, actor))).toBe("DISABLED_BY_POLICY")
    expect(recorded()).toBe("")
  })
})
