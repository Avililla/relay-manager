import fs from "node:fs"
import path from "node:path"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import type { EnterMode, LineSettings } from "@/lib/contracts/enums"
import { isDomainError } from "@/server/errors"
import { createNullLogger } from "@/server/log"
import { createTestDb, fakeAudit, fakeBus, fakeSettings, testConfig, withTempDir, type TestDb } from "../../../test/helpers"
import { createCaptureService, type CaptureService } from "./capture/service"
import { ConsoleManagerImpl } from "./console-manager"
import type { SerialDevice } from "./enumerate"
import { bindingFromDevice } from "./matcher"
import { FakeDiscovery, fakeOpener, RecordingSession, TestReservations, virtualDevice } from "./testing/fakes"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timeout")
    await sleep(10)
  }
}

let db: TestDb
let seq = 0
beforeAll(async () => { db = await createTestDb() })
afterAll(async () => { await db.cleanup() })
// Every test starts from an empty console table (bindingKey is unique; the manager loads every console).
beforeEach(async () => { await db.prisma.serialConsole.deleteMany() })

interface ConsoleSeed { key: string; dev?: SerialDevice | null; line?: Partial<LineSettings>; enterMode?: EnterMode; captureToDisk?: boolean; released?: { until: Date | null } }

async function seed(consoles: ConsoleSeed[], roleIds: string[] = []) {
  seq++
  const eq = await db.prisma.equipment.create({
    data: { name: `EQ-${seq}`, roles: roleIds.length ? { connect: roleIds.map((id) => ({ id })) } : undefined },
  })
  const rows = []
  for (const [i, c] of consoles.entries()) {
    const b = c.dev ? bindingFromDevice(c.dev) : null
    rows.push(await db.prisma.serialConsole.create({
      data: {
        equipmentId: eq.id, position: i, key: c.key, label: c.key,
        baudRate: c.line?.baudRate ?? 115200, dataBits: c.line?.dataBits ?? 8, parity: c.line?.parity ?? "none", stopBits: c.line?.stopBits ?? 1,
        flowControl: c.line?.flowControl ?? "none", enterMode: c.enterMode ?? "cr", captureToDisk: c.captureToDisk ?? true,
        ...(b ? { ...b } : {}),
        ...(c.released ? { releasedAt: new Date(), releasedById: "x", releasedByName: "otro", releaseUntil: c.released.until } : {}),
      },
    }))
  }
  return { eq, rows }
}

let tmp: { dir: string; cleanup: () => void } | null = null
let mgr: ConsoleManagerImpl | null = null
let capture: CaptureService | null = null
afterEach(async () => {
  await mgr?.stop()
  await capture?.stop()
  mgr = null
  capture = null
  tmp?.cleanup()
  tmp = null
})

function harness(devs: SerialDevice[], o: { historyBytes?: number; clock?: { now: number } } = {}) {
  tmp = withTempDir("rm-cm-")
  const bus = fakeBus()
  const audit = fakeAudit()
  const settings = fakeSettings()
  const reservations = new TestReservations()
  const opener = fakeOpener()
  const discovery = new FakeDiscovery(devs)
  const timeline: string[] = []
  const previews = {
    closed: [] as Array<[string, string]>,
    async closeForStableKey(key: string, reason: string) { await sleep(20); previews.closed.push([key, reason]); timeline.push(`preview-closed:${key}`) },
  }
  const origOpen = opener.open
  opener.open = async (opts) => { timeline.push(`open:${opts.path}`); return origOpen(opts) }
  const log = createNullLogger()
  const config = testConfig({ captureDir: path.join(tmp.dir, "consoles") })
  config.serial.historyBytes = o.historyBytes ?? 1024
  capture = createCaptureService({ captureDir: config.captureDir, enabled: true, settings, audit, log, statfs: async () => ({ bsize: 4096, bavail: 1e8, blocks: 2e8 }) })
  const usage = { busy: new Set<string>() }
  const now = o.clock ? () => new Date(o.clock?.now ?? 0) : undefined
  mgr = new ConsoleManagerImpl({
    prisma: db.prisma, bus, audit, settings, log, config, reservations, discovery, capture, openPort: opener.open, previews, usage,
    backoffMs: [60, 120, 240], minuteMs: 40, now, openTimeoutMs: 150,
  })
  return { mgr, bus, audit, reservations, opener, discovery, previews, timeline, usage, capture, config }
}

const adminActor = { kind: "user" as const, id: "admin1", name: "admin", isAdmin: true }
const userActor = (id: string) => ({ kind: "user" as const, id, name: id, isAdmin: false })

describe("ConsoleManagerImpl", () => {
  it("opens bound consoles at start; unbound and released stay closed", async () => {
    const v0 = virtualDevice("ttyV0")
    const v1 = virtualDevice("ttyV1")
    const h = harness([v0, v1])
    const { rows } = await seed([{ key: "UART0", dev: v0 }, { key: "UART1", dev: null }, { key: "AUX", dev: v1, released: { until: null } }])
    await h.mgr.start()
    await until(() => h.mgr.runtime(rows[0].id)?.status === "open")
    expect(h.opener.attempts).toEqual([v0.openPath])
    expect(h.mgr.runtime(rows[0].id)).toMatchObject({ status: "open", devNode: v0.devNode, capture: "active", viewers: 0 })
    expect(h.mgr.runtime(rows[1].id)?.status).toBe("unbound")
    expect(h.mgr.runtime(rows[2].id)).toMatchObject({ status: "released", released: { byName: "otro", until: null } })
    expect(h.opener.last(v0.openPath)?.opts).toMatchObject({ hupcl: false, line: { baudRate: 115200, dataBits: 8, parity: "none", stopBits: 1, flowControl: "none" } })
    const ev = h.bus.events.find((e) => e.event.type === "console.status" && e.event.consoleId === rows[0].id)
    expect(ev?.audience).toEqual({ kind: "equipment", equipmentId: rows[0].equipmentId })
    expect(Object.keys(h.mgr.runtimeForEquipment(rows[0].equipmentId))).toHaveLength(3)
  })

  it("maps open errors to statuses with Spanish details", async () => {
    const devs = ["ttyV0", "ttyV1", "ttyV2", "ttyV3", "ttyV4"].map((n) => virtualDevice(n))
    const h = harness(devs)
    h.opener.fail.set(devs[0].openPath, new Error("Error: Resource temporarily unavailable Cannot lock port"))
    h.opener.fail.set(devs[1].openPath, new Error("Error: Permission denied, cannot open /dev/ttyUSB1"))
    h.opener.fail.set(devs[2].openPath, new Error("Error: Operation not permitted, cannot open /dev/ttyUSB2"))
    h.opener.fail.set(devs[3].openPath, Object.assign(new Error("Error: No such file or directory, cannot open"), { code: "ENOENT" }))
    h.opener.fail.set(devs[4].openPath, new Error("Error: Inappropriate ioctl for device"))
    const { rows } = await seed(devs.map((d, i) => ({ key: `C${i}`, dev: d })))
    await h.mgr.start()
    await until(() => rows.every((r) => h.mgr.runtime(r.id)?.status !== "opening"))
    const st = rows.map((r) => h.mgr.runtime(r.id))
    expect(st[0]).toMatchObject({ status: "busy", detail: "En uso por otro programa (picocom, BITReader_Tool…)" })
    expect(st[1]).toMatchObject({ status: "no-permission", detail: "Sin permiso: el usuario del servicio debe pertenecer al grupo dialout" })
    expect(st[2]).toMatchObject({ status: "no-permission", detail: "Docker: faltan device_cgroup_rules c 188/166" })
    expect(st[3]?.status).toBe("missing")
    expect(st[4]?.status).toBe("error")
    expect(h.usage.busy.has(devs[0].stableKey)).toBe(true)
  })

  it("retries with backoff and a discovery event resets it (replug → reopen)", async () => {
    const v0 = virtualDevice("ttyV0")
    const h = harness([v0])
    h.opener.fail.set(v0.openPath, new Error("Cannot lock port"))
    const { rows } = await seed([{ key: "UART0", dev: v0 }])
    await h.mgr.start()
    await until(() => h.opener.attempts.length >= 3, 1500)   // 0, +60, +120 ms
    h.opener.fail.delete(v0.openPath)
    await until(() => h.mgr.runtime(rows[0].id)?.status === "open", 1500)

    // unplug: the port closes under us → missing; the device leaves the snapshot
    const p1 = h.opener.last(v0.openPath)
    p1?.lose()
    await until(() => h.mgr.runtime(rows[0].id)?.status === "missing")
    expect(h.mgr.runtime(rows[0].id)?.detail).toBe("Se perdió la conexión con el adaptador")
    h.discovery.list = []
    h.mgr.onDiscoveryChange()
    await sleep(300)
    expect(h.mgr.runtime(rows[0].id)).toMatchObject({ status: "missing", detail: "Adaptador no conectado" })
    const n = h.opener.attempts.length
    // replug (new pty behind the same link) → immediate reopen
    h.discovery.list = [virtualDevice("ttyV0", undefined, "/dev/pts/9")]
    const t0 = Date.now()
    h.mgr.onDiscoveryChange()
    await until(() => h.mgr.runtime(rows[0].id)?.status === "open")
    expect(Date.now() - t0).toBeLessThan(200)
    expect(h.opener.attempts.length).toBe(n + 1)
  })

  it("a newly bound console closes the preview on its stableKey first and opens without backoff", async () => {
    const v0 = virtualDevice("ttyV0")
    const h = harness([v0])
    const { eq, rows } = await seed([{ key: "UART0", dev: null }])
    await h.mgr.start()
    expect(h.mgr.runtime(rows[0].id)?.status).toBe("unbound")
    await db.prisma.serialConsole.update({ where: { id: rows[0].id }, data: { ...bindingFromDevice(v0) } })
    await h.mgr.reloadEquipment(eq.id)
    expect(h.previews.closed).toEqual([[v0.stableKey, `Puerto asignado a ${eq.name} · UART0`]])
    expect(h.timeline).toEqual([`preview-closed:${v0.stableKey}`, `open:${v0.openPath}`])
    expect(h.mgr.runtime(rows[0].id)?.status).toBe("open")
  })

  it("release with a duration auto-retakes; release until retake; retake reopens", async () => {
    const v0 = virtualDevice("ttyV0")
    const h = harness([v0])
    const { eq, rows } = await seed([{ key: "UART1", dev: v0 }])
    await h.mgr.start()
    await until(() => h.mgr.runtime(rows[0].id)?.status === "open")
    const p1 = h.opener.last(v0.openPath)

    const rt = await h.mgr.release(rows[0].id, adminActor, null)
    expect(rt).toMatchObject({ status: "released", released: { byName: "admin", until: null } })
    expect(p1?.closed).toBe(true)
    const dbRow = await db.prisma.serialConsole.findUniqueOrThrow({ where: { id: rows[0].id } })
    expect(dbRow).toMatchObject({ releasedById: "admin1", releasedByName: "admin", releaseUntil: null })
    expect(h.audit.inputs.find((i) => i.action === "console.release")).toMatchObject({ equipment: { id: eq.id, name: eq.name }, target: { type: "console", id: rows[0].id, name: "UART1" } })

    const back = await h.mgr.retake(rows[0].id, adminActor)
    expect(back.status).toBe("open")
    expect((await db.prisma.serialConsole.findUniqueOrThrow({ where: { id: rows[0].id } })).releasedAt).toBeNull()
    expect(h.audit.inputs.some((i) => i.action === "console.retake")).toBe(true)

    // 15 "minutes" = 600 ms with minuteMs 40
    await h.mgr.release(rows[0].id, adminActor, 15)
    expect(h.mgr.runtime(rows[0].id)?.released?.until).not.toBeNull()
    await until(() => h.mgr.runtime(rows[0].id)?.status === "open", 2000)
    const auto = h.audit.inputs.filter((i) => i.action === "console.retake").pop()
    expect(auto?.actor.kind).toBe("system")
    await h.capture.idle()
    const log = fs.readdirSync(path.join(h.config.captureDir, rows[0].id)).find((n) => n.endsWith(".log")) ?? ""
    await h.mgr.stop()
    mgr = null
    const text = fs.readFileSync(path.join(h.config.captureDir, rows[0].id, log), "utf8")
    expect(text).toContain("--- puerto soltado por admin ---")
    expect(text).toContain("--- puerto retomado por admin ---")
    expect(text).toMatch(/--- puerto soltado por admin \(hasta \d\d:\d\d UTC\) ---/)
    expect(text).toContain("--- puerto retomado por sistema ---")
  })

  it("release shows the person's display name (like every reservation surface); the audit keeps the username", async () => {
    const v0 = virtualDevice("ttyV0")
    const h = harness([v0])
    const { rows } = await seed([{ key: "UART1", dev: v0 }])
    await h.mgr.start()
    await until(() => h.mgr.runtime(rows[0].id)?.status === "open")
    const rt = await h.mgr.release(rows[0].id, { ...adminActor, displayName: "Jorge Duro" }, null)
    expect(rt.released?.byName).toBe("Jorge Duro")
    expect(await db.prisma.serialConsole.findUniqueOrThrow({ where: { id: rows[0].id } })).toMatchObject({ releasedByName: "Jorge Duro" })
    expect(h.audit.inputs.find((i) => i.action === "console.release")?.actor).toMatchObject({ name: "admin" })
  })

  it("write rule for release/retake/clear (D24)", async () => {
    const v0 = virtualDevice("ttyV0")
    const h = harness([v0])
    const { eq, rows } = await seed([{ key: "UART0", dev: v0 }])
    await h.mgr.start()
    const code = async (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => (isDomainError(e) ? e.code : "?"))
    // free unit: admin ok, plain user NOT_HOLDER
    expect(await code(h.mgr.clearHistory(rows[0].id, userActor("u1")))).toBe("NOT_HOLDER")
    expect(await code(h.mgr.clearHistory(rows[0].id, adminActor))).toBe("ok")
    // held by u1: holder ok, admin RESERVED_BY_OTHER, another user NOT_HOLDER
    h.reservations.set(eq.id, { id: "u1", name: "u1" }, "reserve")
    expect(await code(h.mgr.release(rows[0].id, adminActor, null))).toBe("RESERVED_BY_OTHER")
    expect(await code(h.mgr.retake(rows[0].id, adminActor))).toBe("RESERVED_BY_OTHER")
    expect(await code(h.mgr.release(rows[0].id, userActor("u2"), null))).toBe("NOT_HOLDER")
    expect(await code(h.mgr.release(rows[0].id, userActor("u1"), null))).toBe("ok")
    expect(await code(h.mgr.retake(rows[0].id, userActor("u1")))).toBe("ok")
    // the system actor (auto-retake) bypasses the rule
    expect(await code(h.mgr.release(rows[0].id, { kind: "system", id: null, name: "sistema", isAdmin: false }, null))).toBe("ok")
    expect(await code(h.mgr.release("nope", adminActor, null))).toBe("NOT_FOUND")
  })

  it("history ring: size, replay order and truncation; clear", async () => {
    const v0 = virtualDevice("ttyV0")
    const h = harness([v0], { historyBytes: 16 })
    const { rows } = await seed([{ key: "UART0", dev: v0 }])
    await h.mgr.start()
    await until(() => h.mgr.runtime(rows[0].id)?.status === "open")
    const data = "0123456789abcdefghijklmnopqrstuvwxyz\r\nlogin: "
    h.opener.last(v0.openPath)?.emit(data)
    const s = new RecordingSession(rows[0].id, "u1", "Uno")
    h.mgr.attachSession(s)
    expect(s.order[0]).toBe("json")
    const hello = s.of("hello")[0]
    expect(hello).toMatchObject({ kind: "console", consoleId: rows[0].id, key: "UART0", mode: "ro", historyBytes: 16, enterMode: "cr", localEcho: false })
    expect(s.text()).toBe(data.slice(-16))
    expect(s.of("history-end")[0]).toEqual({ t: "history-end", bytes: 16, truncated: true })
    expect(s.order.slice(-1)[0]).toBe("json")
    await h.mgr.clearHistory(rows[0].id, adminActor)
    expect(s.of("cleared")[0]).toEqual({ t: "cleared", byName: "admin" })
    const s2 = new RecordingSession(rows[0].id, "u2", "Dos")
    h.mgr.attachSession(s2)
    expect(s2.of("history-end")[0]).toEqual({ t: "history-end", bytes: 0, truncated: false })
  })

  it("fans out live data to every session", async () => {
    const v0 = virtualDevice("ttyV0")
    const h = harness([v0])
    const { rows } = await seed([{ key: "UART0", dev: v0 }])
    await h.mgr.start()
    await until(() => h.mgr.runtime(rows[0].id)?.status === "open")
    const a = new RecordingSession(rows[0].id, "u1", "Uno")
    const b = new RecordingSession(rows[0].id, "u2", "Dos")
    h.mgr.attachSession(a)
    h.mgr.attachSession(b)
    h.opener.last(v0.openPath)?.emit("U-Boot 2022.01\r\n")
    expect(a.text()).toBe("U-Boot 2022.01\r\n")
    expect(b.text()).toBe("U-Boot 2022.01\r\n")
    await until(() => a.of("viewers").length > 0, 2500)
    expect(a.of("viewers").pop()?.viewers.map((v) => v.userId).sort()).toEqual(["u1", "u2"])
    expect(h.mgr.runtime(rows[0].id)?.viewers).toBe(2)
  })

  it("write gating, enter mapping, reservation lost mid-session, rate limit, break", async () => {
    const v0 = virtualDevice("ttyV0")
    const h = harness([v0])
    const { eq, rows } = await seed([{ key: "UART0", dev: v0, enterMode: "crlf" }])
    await h.mgr.start()
    await until(() => h.mgr.runtime(rows[0].id)?.status === "open")
    const port = h.opener.last(v0.openPath)
    const s = new RecordingSession(rows[0].id, "u1", "Uno", "uno")
    h.mgr.attachSession(s)
    h.mgr.write(s, Buffer.from("root\r"))
    expect(s.of("input-rejected")[0]).toEqual({ t: "input-rejected", reason: "not-holder" })
    expect(port?.writes).toEqual([])

    h.reservations.set(eq.id, { id: "u1", name: "Uno" }, "reserve")
    expect(s.mode).toBe("rw")
    expect(s.of("mode").pop()).toEqual({ t: "mode", mode: "rw", reason: "reserved" })
    h.mgr.write(s, Buffer.from("root\r"))
    await sleep(10)
    expect(port?.written()).toBe("root\r\n")
    expect(h.reservations.touches).toEqual([{ equipmentId: eq.id, userId: "u1" }])

    // rate limit: 64 KiB per second per session
    h.mgr.write(s, Buffer.alloc(40_000, 0x61))
    h.mgr.write(s, Buffer.alloc(40_000, 0x62))
    expect(s.of("input-rejected").pop()).toEqual({ t: "input-rejected", reason: "rate-limited" })

    // break: holder only
    await h.mgr.sendBreak(s, 60)
    expect(port?.sets).toEqual([{ brk: true }, { brk: false }])
    expect(h.audit.inputs.some((i) => i.action === "console.break")).toBe(true)

    // reservation lost without a notification (defense in depth at write time)
    h.reservations.holders.delete(eq.id)
    const before = port?.writes.length
    h.mgr.write(s, Buffer.from("x"))
    expect(port?.writes.length).toBe(before)
    expect(s.of("input-rejected").pop()).toEqual({ t: "input-rejected", reason: "not-holder" })
    expect(s.mode).toBe("ro")
    await h.mgr.sendBreak(s, 60)
    expect(port?.sets).toHaveLength(2)

    // expiry notified → ro with reason
    h.reservations.set(eq.id, { id: "u1", name: "Uno" }, "reserve")
    h.reservations.set(eq.id, null, "expire")
    expect(s.of("mode").pop()).toEqual({ t: "mode", mode: "ro", reason: "expired" })
    // someone else reserves: ro viewers learn it
    h.reservations.set(eq.id, { id: "u9", name: "Nueve" }, "reserve")
    expect(s.of("mode").pop()).toEqual({ t: "mode", mode: "ro", reason: "reserved-by-other" })
  })

  it("enterMode lf and port-not-open", async () => {
    const v0 = virtualDevice("ttyV0")
    const h = harness([v0])
    const { eq, rows } = await seed([{ key: "UART0", dev: v0, enterMode: "lf" }])
    await h.mgr.start()
    await until(() => h.mgr.runtime(rows[0].id)?.status === "open")
    const s = new RecordingSession(rows[0].id, "u1", "Uno")
    h.mgr.attachSession(s)
    h.reservations.set(eq.id, { id: "u1", name: "Uno" }, "reserve")
    h.mgr.write(s, Buffer.from("a\rb\r"))
    await sleep(5)
    expect(h.opener.last(v0.openPath)?.written()).toBe("a\nb\n")
    await h.mgr.release(rows[0].id, userActor("u1"), null)
    h.mgr.write(s, Buffer.from("x"))
    expect(s.of("input-rejected").pop()).toEqual({ t: "input-rejected", reason: "port-not-open" })
  })

  it("reconfigure → reopen with the new line settings (session stays); delete → 4011", async () => {
    const v0 = virtualDevice("ttyV0")
    const h = harness([v0])
    const { eq, rows } = await seed([{ key: "UART0", dev: v0 }, { key: "UART1", dev: null }])
    await h.mgr.start()
    await until(() => h.mgr.runtime(rows[0].id)?.status === "open")
    const s = new RecordingSession(rows[0].id, "u1", "Uno")
    h.mgr.attachSession(s)
    const p1 = h.opener.last(v0.openPath)
    await db.prisma.serialConsole.update({ where: { id: rows[0].id }, data: { baudRate: 9600, label: "Nueva" } })
    await h.mgr.reloadConsole(rows[0].id)
    expect(p1?.closed).toBe(true)
    expect(h.opener.last(v0.openPath)?.opts.line.baudRate).toBe(9600)
    expect(h.mgr.runtime(rows[0].id)?.status).toBe("open")
    expect(s.closedWith).toBeNull()
    expect(s.of("status").length).toBeGreaterThan(0)

    await db.prisma.serialConsole.delete({ where: { id: rows[0].id } })
    await h.mgr.reloadEquipment(eq.id)
    expect(s.closedWith?.code).toBe(4011)
    expect(h.mgr.runtime(rows[0].id)).toBeNull()
    expect(h.opener.last(v0.openPath)?.closed).toBe(true)
    // new console created → added
    const c = await db.prisma.serialConsole.create({ data: { equipmentId: eq.id, position: 5, key: "AUX", label: "AUX", ...bindingFromDevice(v0) } })
    await h.mgr.reloadConsole(c.id)
    await until(() => h.mgr.runtime(c.id)?.status === "open")
  })

  it("console.activity is throttled and republished for a repeated line after 2 s", async () => {
    const v0 = virtualDevice("ttyV0")
    const clock = { now: Date.parse("2026-09-23T10:00:00.000Z") }
    const h = harness([v0], { clock })
    const { rows } = await seed([{ key: "UART0", dev: v0 }])
    await h.mgr.start()
    await until(() => h.mgr.runtime(rows[0].id)?.status === "open")
    const port = h.opener.last(v0.openPath)
    const acts = () => h.bus.events.filter((e) => e.event.type === "console.activity").map((e) => e.event)
    port?.emit("placa login: ")
    expect(acts()).toHaveLength(1)
    expect(acts()[0]).toMatchObject({ consoleId: rows[0].id, lastLine: "placa login:" })
    clock.now += 100
    port?.emit("\r\nplaca login: ")                          // same line, 100 ms later: not republished
    expect(acts()).toHaveLength(1)
    clock.now += 2100
    port?.emit("\r\nplaca login: ")                          // same line, > 2 s later: republished
    expect(acts()).toHaveLength(2)
    expect(h.mgr.runtime(rows[0].id)?.lastLine).toBe("placa login:")
  })

  it("a hung open gives up (error + retry) and a late handle is closed", async () => {
    const v0 = virtualDevice("ttyV0")
    const h = harness([v0])
    let hang = true
    const late: Array<() => void> = []
    const base = h.opener.open
    const { rows } = await seed([{ key: "UART0", dev: v0 }])
    const mgrOpts = h.mgr as unknown as { o: { openPort: typeof base } }
    mgrOpts.o.openPort = (opts) => hang
      ? new Promise((resolve) => { late.push(() => { void base(opts).then(resolve) }) })
      : base(opts)
    await h.mgr.start()
    await until(() => h.mgr.runtime(rows[0].id)?.status === "error", 1000)
    expect(h.mgr.runtime(rows[0].id)?.detail).toContain("Tiempo de espera agotado")
    hang = false
    for (const f of late) f()
    await until(() => h.mgr.runtime(rows[0].id)?.status === "open", 2000)
    await sleep(50)
    const open = h.opener.ports.filter((p) => !p.closed)
    expect(open).toHaveLength(1)
  })

  it("never opens a path outside the discovery snapshot", async () => {
    const v0 = virtualDevice("ttyV0")
    const h = harness([v0])
    const { rows } = await seed([{ key: "X", dev: v0 }, { key: "Y", dev: null }])
    // a path outside the allowed prefixes is not even a valid binding record
    await db.prisma.serialConsole.update({ where: { id: rows[0].id }, data: { bindingKey: "virtual:/etc/passwd", devicePath: "/etc/passwd", lastDevNode: "/etc/passwd" } })
    // an allowed path that is not in the discovery snapshot is simply missing
    await db.prisma.serialConsole.update({ where: { id: rows[1].id }, data: { matchBy: "path", bindingKey: "dev:ttyS9", devicePath: "/dev/ttyS9", lastDevNode: "/dev/ttyS9" } })
    await h.mgr.start()
    await sleep(100)
    expect(h.opener.attempts).toEqual([])
    expect(h.mgr.runtime(rows[0].id)).toMatchObject({ status: "error", detail: "Asignación no válida: vuelve a asignar el puerto" })
    expect(h.mgr.runtime(rows[1].id)).toMatchObject({ status: "missing", detail: "Adaptador no conectado" })
    expect(h.mgr.assignmentFor(v0.stableKey)).toBeNull()
  })

  it("assignment and in-use annotations for discovery", async () => {
    const v0 = virtualDevice("ttyV0")
    const v1 = virtualDevice("ttyV1")
    const h = harness([v0, v1])
    const { eq, rows } = await seed([{ key: "UART0", dev: v0 }])
    await h.mgr.start()
    await until(() => h.mgr.runtime(rows[0].id)?.status === "open")
    expect(h.mgr.assignmentFor(v0.stableKey)).toEqual({ equipmentId: eq.id, equipmentName: eq.name, consoleId: rows[0].id, consoleKey: "UART0", consoleLabel: "UART0" })
    expect(h.mgr.isHeldOpen(v0.stableKey)).toBe(true)
    expect(h.mgr.isHeldOpen(v1.stableKey)).toBe(false)
    expect(h.mgr.isBound(v0.stableKey)).toBe(true)
    expect(h.mgr.heldHistory(v0.stableKey)).not.toBeNull()
    expect(h.mgr.stats()).toEqual({ openConsoles: 1, problemConsoles: 0 })
  })

  it("taps (serial-over-TCP accesses) get the history tail, live data and status, write as-is, and hear about removal", async () => {
    const v0 = virtualDevice("ttyV0")
    const h = harness([v0])
    const { rows } = await seed([{ key: "UART0", dev: v0, enterMode: "crlf" }])
    await h.mgr.start()
    await until(() => h.mgr.runtime(rows[0].id)?.status === "open")
    const port = h.opener.last(v0.openPath)
    port?.emit("U-Boot 2022.01\r\n")
    const got: string[] = []
    const statuses: string[] = []
    let gone = 0
    const tap = { onData: (b: Buffer) => got.push(b.toString()), onStatus: (r: { status: string }) => statuses.push(r.status), onGone: () => { gone++ } }
    const hello = h.mgr.attachTap(rows[0].id, tap, 6)
    expect(hello).toMatchObject({ key: "UART0", label: "UART0", equipmentName: expect.stringMatching(/^EQ-/), runtime: { status: "open" } })
    expect(hello?.history.toString()).toBe("2.01\r\n")
    port?.emit("login: ")
    expect(got).toEqual(["login: "])
    expect(h.mgr.writeFromTap(rows[0].id, Buffer.from("root\r"), "tcp 10.0.0.2")).toBe("ok")
    expect(port?.written()).toBe("root\r")                  // as-is: no Enter mapping for raw TCP clients
    expect(h.mgr.runtime(rows[0].id)?.viewers).toBe(0)       // taps are not web viewers
    await h.mgr.release(rows[0].id, adminActor, null)
    expect(statuses).toContain("released")
    expect(h.mgr.writeFromTap(rows[0].id, Buffer.from("x"), "tcp 10.0.0.2")).toBe("port-not-open")
    await db.prisma.serialConsole.delete({ where: { id: rows[0].id } })
    await h.mgr.reloadConsole(rows[0].id)
    expect(gone).toBe(1)
    expect(h.mgr.attachTap(rows[0].id, tap, 10)).toBeNull()
    expect(h.mgr.writeFromTap(rows[0].id, Buffer.from("x"), "tcp")).toBe("missing")
  })
})
