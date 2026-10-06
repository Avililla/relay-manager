// Real ptys (scripts/sim/fake-zynq.py) through the real serialport binding, sysfs-less discovery via extra globs,
// continuous capture on disk. Skipped when python3 is missing (§11.1).
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { SerialPort } from "serialport"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { createNullLogger } from "@/server/log"
import type { SerialServices } from "@/server/runtime/types"
import { createTestDb, fakeAudit, fakeBus, fakeSessions, fakeSettings, testConfig, withTempDir, type TestDb } from "../../../test/helpers"
import { scanSerialPorts } from "./enumerate"
import { createSerialServices } from "./index"
import { bindingFromDevice } from "./matcher"
import { TestReservations } from "./testing/fakes"

const hasPython = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0
const FAKE = path.resolve(__dirname, "../../../scripts/sim/fake-zynq.py")
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(cond: () => boolean | Promise<boolean>, ms: number): Promise<number> {
  const t0 = Date.now()
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error("timeout")
    await sleep(25)
  }
  return Date.now() - t0
}

let db: TestDb
let tmp: { dir: string; cleanup: () => void }
let sim: string
const kids = new Set<ChildProcess>()
let serial: SerialServices | null = null

function fake(name: string, args: string[]): Promise<ChildProcess> {
  const ch = spawn("python3", [FAKE, "--link", path.join(sim, name), ...args], { stdio: ["ignore", "pipe", "inherit"] })
  kids.add(ch)
  ch.on("exit", () => kids.delete(ch))
  return new Promise((resolve, reject) => {
    ch.stdout?.once("data", () => resolve(ch))
    ch.once("error", reject)
  })
}
function stop(ch: ChildProcess, sig: NodeJS.Signals = "SIGTERM"): Promise<void> {
  return new Promise((r) => {
    if (ch.exitCode !== null) return r()
    ch.once("exit", () => r())
    ch.kill(sig)
  })
}

beforeAll(async () => {
  db = await createTestDb()
  tmp = withTempDir("rm-pty-")
  sim = path.join(tmp.dir, "sim")
  fs.mkdirSync(sim)
})
afterEach(async () => {
  await serial?.stop()
  serial = null
  await Promise.all([...kids].map((k) => stop(k, "SIGKILL")))
  await db.prisma.serialConsole.deleteMany()
})
afterAll(async () => {
  await db.cleanup()
  tmp.cleanup()
})

async function bindConsole(name: string, key: string): Promise<string> {
  const devs = await scanSerialPorts({ sysRoot: path.join(tmp.dir, "sys"), devRoot: path.join(tmp.dir, "dev"), extraGlobs: [path.join(sim, "ttyV*")], includeBuiltin: false })
  const dev = devs.find((d) => d.name === name)
  if (!dev) throw new Error(`no ${name}`)
  const eq = await db.prisma.equipment.upsert({ where: { name: "Equipo A #01" }, create: { name: "Equipo A #01" }, update: {} })
  const pos = await db.prisma.serialConsole.count({ where: { equipmentId: eq.id } })
  return (await db.prisma.serialConsole.create({ data: { equipmentId: eq.id, position: pos, key, label: key, ...bindingFromDevice(dev) } })).id
}

async function startServices(): Promise<{ serial: SerialServices; captureDir: string; audit: ReturnType<typeof fakeAudit> }> {
  const captureDir = path.join(tmp.dir, `cap-${Date.now()}`)
  const config = testConfig({ captureDir })
  config.serial = { ...config.serial, sysRoot: path.join(tmp.dir, "sys"), devRoot: path.join(tmp.dir, "dev"), extraGlobs: [path.join(sim, "ttyV*")], scanIntervalMs: 500, settleMs: 100 }
  const audit = fakeAudit()
  serial = createSerialServices(
    { config, log: createNullLogger(), prisma: db.prisma, bus: fakeBus(), audit, settings: fakeSettings(), reservations: new TestReservations(), sessions: fakeSessions(), authenticate: async () => null },
    { probeTimings: { pokeListenMs: 300, pokeAfterMs: 800, bootExtraMs: 1500 } },
  )
  await serial.start()
  return { serial, captureDir, audit }
}

const openFds = (target: string): number => {
  let n = 0
  for (const fd of fs.readdirSync("/proc/self/fd")) {
    try { if (fs.readlinkSync(`/proc/self/fd/${fd}`) === target) n++ } catch { /* closed meanwhile */ }
  }
  return n
}

describe.skipIf(!hasPython || process.platform !== "linux")("real ptys (fake-zynq)", () => {
  it("holds the pty open from start and captures with timestamps, with no browser", async () => {
    await fake("ttyV0", ["--stage", "login", "--host", "equipo-a-01-uart0", "--tick", "0.2"])
    const id = await bindConsole("ttyV0", "UART0")
    const { serial: s, captureDir } = await startServices()
    await until(() => s.consoles.runtime(id)?.status === "open", 3000)
    const pts = fs.realpathSync(path.join(sim, "ttyV0"))
    expect(openFds(pts)).toBe(1)
    await sleep(900)
    const files = await s.consoles.listCaptureFiles(id, { includeInput: false })
    expect(files).toHaveLength(1)
    const text = fs.readFileSync(path.join(captureDir, id, files[0].name), "utf8")
    expect(text).toMatch(/^# relay-manager captura v1 · equipo "Equipo A #01"/)
    expect(text).toMatch(/# \S+Z abierto \S+ttyV0 115200 8N1/)
    expect(text.match(/^\[\d{4}-\d\d-\d\dT[\d:.]+Z\] \[\s+[\d.]+\] equipo-a-01-uart0: heartbeat$/gm)?.length).toBeGreaterThanOrEqual(2)
    expect(s.consoles.runtime(id)?.lastLine).toContain("heartbeat")
  }, 20_000)

  it("release frees the pty for another program; retake re-acquires it", async () => {
    await fake("ttyV1", ["--stage", "login", "--host", "equipo-a-01-uart1"])
    const id = await bindConsole("ttyV1", "UART1")
    const { serial: s } = await startServices()
    await until(() => s.consoles.runtime(id)?.status === "open", 3000)
    const pts = fs.realpathSync(path.join(sim, "ttyV1"))
    const admin = { kind: "user" as const, id: "adm", name: "admin", isAdmin: true }

    // while we hold it, a second flock opener (picocom, BITReader_Tool…) is refused
    const busy = new SerialPort({ path: path.join(sim, "ttyV1"), baudRate: 115200, autoOpen: false, lock: true })
    expect(await new Promise<string | null>((r) => busy.open((e) => r(e?.message ?? null)))).toMatch(/lock/i)

    const rt = await s.consoles.release(id, admin, 15)
    expect(rt.status).toBe("released")
    expect(openFds(pts)).toBe(0)
    const other = new SerialPort({ path: path.join(sim, "ttyV1"), baudRate: 115200, autoOpen: false, lock: true })
    expect(await new Promise<string | null>((r) => other.open((e) => r(e?.message ?? null)))).toBeNull()
    await new Promise<void>((r) => other.close(() => r()))

    expect((await s.consoles.retake(id, admin)).status).toBe("open")
    expect(openFds(pts)).toBe(1)
  }, 20_000)

  it("killing and restarting the fake console reopens within 3 s", async () => {
    const first = await fake("ttyV2", ["--stage", "shell", "--host", "equipo-a-02-uart0"])
    const id = await bindConsole("ttyV2", "UART0")
    const { serial: s } = await startServices()
    await until(() => s.consoles.runtime(id)?.status === "open", 3000)
    await stop(first, "SIGKILL")                                 // USB unplug: the pty vanishes under us
    await until(() => s.consoles.runtime(id)?.status !== "open", 3000)
    expect(s.consoles.runtime(id)?.status).toBe("missing")
    const t0 = Date.now()
    await fake("ttyV2", ["--stage", "shell", "--host", "equipo-a-02-uart0"]) // replug
    await until(() => s.consoles.runtime(id)?.status === "open", 3000)
    expect(Date.now() - t0).toBeLessThan(3000)
    expect(openFds(fs.realpathSync(path.join(sim, "ttyV2")))).toBe(1)
  }, 20_000)

  it("identify never writes: a U-Boot countdown on a real pty is not interrupted", async () => {
    await fake("ttyV3", ["--stage", "boot", "--host", "equipo-a-02-uart1", "--autoboot", "2", "--speed", "1"])
    const { serial: s, audit } = await startServices()
    const key = `virtual:${path.join(sim, "ttyV3")}`
    const [r] = await s.probe.identify([key], { baudRate: 115200, listenMs: 1500 }, { kind: "user", id: "adm", name: "admin" })
    expect(["uboot-autoboot", "uboot-prompt", "linux-booting", "login", "fsbl"]).toContain(r.state)
    expect(r.poked).toBe(false)
    expect(audit.inputs.some((i) => i.action === "console.probe")).toBe(true)
    // the board kept booting to the login prompt: nothing stopped autoboot
    const reader = new SerialPort({ path: path.join(sim, "ttyV3"), baudRate: 115200, autoOpen: false, lock: true })
    await new Promise<void>((res, rej) => reader.open((e) => (e ? rej(e) : res())))
    let seen = ""
    reader.on("data", (b: Buffer) => { seen += b.toString("latin1") })
    await until(() => /equipo-a-02-uart1 login: $/.test(seen) || seen.includes("Zynq>"), 6000)
    expect(seen).toContain("equipo-a-02-uart1 login:")
    expect(seen).not.toContain("Zynq>")
    await new Promise<void>((res) => reader.close(() => res()))
  }, 20_000)

  it("poke sends one carriage return to a free port and classifies the answer", async () => {
    await fake("ttyV4", ["--stage", "login", "--host", "equipo-c-01"])
    const { serial: s } = await startServices()
    const r = await s.probe.poke(`virtual:${path.join(sim, "ttyV4")}`, { baudRate: 115200 }, { kind: "user", id: "adm", name: "admin" })
    expect(r).toMatchObject({ state: "login", hostname: "equipo-c-01", poked: true })
  }, 20_000)
})
