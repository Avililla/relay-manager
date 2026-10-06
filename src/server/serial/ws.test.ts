// WS handler integration (§5, §11.2): a real http server + the W0 upgrade router + `ws` clients.
import http from "node:http"
import path from "node:path"
import type { AddressInfo } from "node:net"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import WebSocket from "ws"
import type { WsServerMsg } from "@/lib/contracts/ws"
import { attachUpgradeRouter } from "@/server/http/upgrade"
import { createNullLogger } from "@/server/log"
import type { AuthenticatedSession, SerialServices } from "@/server/runtime/types"
import { createTestDb, fakeAudit, fakeBus, fakeSessions, fakeSettings, makeUser, testConfig, withTempDir, type TestDb } from "../../../test/helpers"
import { createSerialServices } from "./index"
import { bindingFromDevice } from "./matcher"
import { fakeOpener, TestReservations, virtualDevice, type FakeOpener } from "./testing/fakes"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timeout")
    await sleep(10)
  }
}

let db: TestDb
let tmp: { dir: string; cleanup: () => void }
const users: Record<string, { id: string; username: string; name: string; isAdmin: boolean; roleIds: string[] }> = {}
let eqVisible: { id: string; name: string }
let eqHidden: { id: string; name: string }
let consoleId: string
let hiddenConsoleId: string
const v0 = virtualDevice("ttyV0")
const v1 = virtualDevice("ttyV1")
const v2 = virtualDevice("ttyV2")

beforeAll(async () => {
  db = await createTestDb()
  tmp = withTempDir("rm-ws-")
  const role = await db.prisma.role.create({ data: { name: "Secreto" } })
  for (const [k, o] of Object.entries({ admin: { isAdmin: true }, ana: {}, bea: {}, secret: { roleIds: [role.id] } })) {
    const u = await makeUser(db.prisma, { username: k, name: k.toUpperCase(), ...o })
    users[k] = { id: u.id, username: u.username, name: u.name, isAdmin: u.isAdmin, roleIds: u.roles.map((r) => r.id) }
  }
  eqVisible = await db.prisma.equipment.create({ data: { name: "Equipo A #01" } })
  eqHidden = await db.prisma.equipment.create({ data: { name: "Equipo A #99", roles: { connect: [{ id: role.id }] } } })
  consoleId = (await db.prisma.serialConsole.create({ data: { equipmentId: eqVisible.id, position: 0, key: "UART0", label: "UART0", ...bindingFromDevice(v0) } })).id
  hiddenConsoleId = (await db.prisma.serialConsole.create({ data: { equipmentId: eqHidden.id, position: 0, key: "UART1", label: "UART1", ...bindingFromDevice(v2) } })).id
})
afterAll(async () => {
  await db.cleanup()
  tmp.cleanup()
})

interface Ctx {
  server: http.Server
  port: number
  serial: SerialServices
  opener: FakeOpener
  reservations: TestReservations
  sessions: ReturnType<typeof fakeSessions>
  audit: ReturnType<typeof fakeAudit>
  authGate: { hang: boolean }
  /** While `hold` is set, the console visibility lookup (serialConsole.findUnique) waits on it. */
  lookupGate: { hold: Promise<void> | null; entered: number }
  /** The next open of each of these paths hangs forever. */
  hangOnce: Set<string>
  /** Opens of these paths wait on the promise (then succeed); `entered` counts the waiting opens. */
  openGate: { holds: Map<string, Promise<void>>; entered: number }
}
let ctx: Ctx | null = null

async function start(o: { openTimeoutMs?: number; previewGraceMs?: number } = {}): Promise<Ctx> {
  const config = testConfig({ captureDir: path.join(tmp.dir, `cap-${Date.now()}`), host: "127.0.0.1" })
  const reservations = new TestReservations()
  const sessions = fakeSessions()
  const audit = fakeAudit()
  const opener = fakeOpener()
  const authGate = { hang: false }
  const lookupGate: Ctx["lookupGate"] = { hold: null, entered: 0 }
  const hangOnce = new Set<string>()
  const openGate: Ctx["openGate"] = { holds: new Map(), entered: 0 }
  const gatedConsoles = new Proxy(db.prisma.serialConsole, {
    get(t, p) {
      const v: unknown = Reflect.get(t, p)
      if (typeof v !== "function") return v
      const f = (v as (...a: unknown[]) => unknown).bind(t)
      if (p !== "findUnique") return f
      return async (...a: unknown[]) => {
        const hold = lookupGate.hold
        if (hold) { lookupGate.entered++; await hold }
        return f(...a)
      }
    },
  })
  const prisma = new Proxy(db.prisma, { get: (t, p) => (p === "serialConsole" ? gatedConsoles : Reflect.get(t, p)) })
  const authenticate = async (req: http.IncomingMessage): Promise<AuthenticatedSession | null> => {
    if (authGate.hang) return new Promise(() => {})
    const m = /(?:^|;\s*)rm=([^;]+)/.exec(req.headers.cookie ?? "")
    const u = m ? Object.values(users).find((x) => x.id === m[1]) : undefined
    if (!u) return null
    const row = await db.prisma.user.findUniqueOrThrow({ where: { id: u.id }, include: { roles: true } })
    return {
      user: { id: row.id, username: row.username, name: row.name, isAdmin: row.isAdmin, roleIds: row.roles.map((r) => r.id), mustChangePassword: row.mustChangePassword, sessionVersion: row.sessionVersion },
      sv: row.sessionVersion, loginAt: Date.now(),
    }
  }
  const serial = createSerialServices(
    { config, log: createNullLogger(), prisma, bus: fakeBus(), audit, settings: fakeSettings(), reservations, sessions, authenticate },
    { scan: async () => [v0, v1, v2], watch: () => ({ close() {} }), handshakeTimeoutMs: 300, openTimeoutMs: o.openTimeoutMs ?? 150,
      previewGraceMs: o.previewGraceMs,
      openPort: async (p) => {
        if (hangOnce.delete(p.path)) return new Promise<never>(() => {})
        const hold = openGate.holds.get(p.path)
        if (hold) { openGate.entered++; await hold }
        return opener.open(p)
      },
      statfs: async () => ({ bsize: 4096, bavail: 1e8, blocks: 2e8 }) },
  )
  await serial.start()
  const server = http.createServer((_req, res) => { res.statusCode = 404; res.end() })
  attachUpgradeRouter(server, { config, serial, log: createNullLogger() })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()))
  const port = (server.address() as AddressInfo).port
  ctx = { server, port, serial, opener, reservations, sessions, audit, authGate, lookupGate, hangOnce, openGate }
  await until(() => serial.consoles.runtime(consoleId)?.status === "open")
  return ctx
}

afterEach(async () => {
  if (!ctx) return
  await ctx.serial.stop()
  ctx.server.closeAllConnections()
  await new Promise<void>((r) => ctx?.server.close(() => r()))
  ctx = null
})

interface Client {
  ws: WebSocket
  msgs: WsServerMsg[]
  bin: Buffer[]
  order: string[]
  closed: Promise<{ code: number; reason: string }>
  status: Promise<number | null>
  wait<T extends WsServerMsg["t"]>(t: T, n?: number): Promise<Extract<WsServerMsg, { t: T }>>
}

function connect(c: Ctx, pathname: string, o: { user?: string; origin?: string | null } = {}): Client {
  const headers: Record<string, string> = {}
  if (o.origin !== null) headers.origin = o.origin ?? `http://127.0.0.1:${c.port}`
  if (o.user) headers.cookie = `rm=${users[o.user].id}`
  const ws = new WebSocket(`ws://127.0.0.1:${c.port}${pathname}`, { headers })
  const msgs: WsServerMsg[] = []
  const bin: Buffer[] = []
  const order: string[] = []
  ws.on("message", (data, isBinary) => {
    const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer)
    if (isBinary) { bin.push(buf); order.push("binary") } else {
      const m = JSON.parse(buf.toString("utf8")) as WsServerMsg
      msgs.push(m)
      order.push(m.t)
    }
  })
  const closed = new Promise<{ code: number; reason: string }>((r) => ws.on("close", (code, reason) => r({ code, reason: reason.toString() })))
  const status = new Promise<number | null>((r) => {
    ws.on("unexpected-response", (_req, res) => { r(res.statusCode ?? null); ws.terminate() })
    ws.on("upgrade", () => r(101))
    ws.on("error", () => r(null))
  })
  const wait = async <T extends WsServerMsg["t"]>(t: T, n = 1) => {
    await until(() => msgs.filter((m) => m.t === t).length >= n, 3000)
    return msgs.filter((m): m is Extract<WsServerMsg, { t: T }> => m.t === t)[n - 1]
  }
  return { ws, msgs, bin, order, closed, status, wait }
}

describe("console WebSocket", () => {
  it("bad or missing Origin → HTTP 403 (W0 router)", async () => {
    const c = await start()
    expect(await connect(c, `/ws/console/${consoleId}`, { user: "ana", origin: "http://evil.example:1" }).status).toBe(403)
    expect(await connect(c, `/ws/console/${consoleId}`, { user: "ana", origin: null }).status).toBe(403)
  })

  it("no session → 4001; unknown or invisible console → 4004 (same reason)", async () => {
    const c = await start()
    expect(await connect(c, `/ws/console/${consoleId}`).closed).toEqual({ code: 4001, reason: "Sesión no válida" })
    expect(await connect(c, `/ws/console/doesnotexist`, { user: "ana" }).closed).toEqual({ code: 4004, reason: "Consola no encontrada" })
    expect(await connect(c, `/ws/console/${hiddenConsoleId}`, { user: "ana" }).closed).toEqual({ code: 4004, reason: "Consola no encontrada" })
    const ok = connect(c, `/ws/console/${hiddenConsoleId}`, { user: "secret" })
    expect((await ok.wait("hello")).kind).toBe("console")
    ok.ws.close()
  })

  it("read-only hello → history → history-end, then live data; input in ro is rejected", async () => {
    const c = await start()
    c.opener.last(v0.openPath)?.emit("U-Boot 2022.01\r\nplaca login: ")
    const cl = connect(c, `/ws/console/${consoleId}`, { user: "ana" })
    const hello = await cl.wait("hello")
    expect(hello).toMatchObject({ t: "hello", protocol: 1, kind: "console", consoleId, equipmentId: eqVisible.id, key: "UART0", mode: "ro", historyBytes: 29 })
    await cl.wait("history-end")
    expect(cl.order.slice(0, 3)).toEqual(["hello", "binary", "history-end"])
    expect(Buffer.concat(cl.bin).toString()).toBe("U-Boot 2022.01\r\nplaca login: ")
    c.opener.last(v0.openPath)?.emit("más\r\n")
    await until(() => Buffer.concat(cl.bin).toString().endsWith("más\r\n"))
    cl.ws.send(Buffer.from("root\r"))
    expect(await cl.wait("input-rejected")).toEqual({ t: "input-rejected", reason: "not-holder" })
    expect(c.opener.last(v0.openPath)?.writes).toEqual([])
    cl.ws.close()
    await cl.closed
    await until(() => c.audit.inputs.some((i) => i.action === "console.session.close"))
    const close = c.audit.inputs.find((i) => i.action === "console.session.close")
    expect(close?.detail).toMatchObject({ mode: "ro", bytesIn: 5 })
    expect(c.audit.inputs.find((i) => i.action === "console.session.open")?.detail).toEqual({ mode: "ro" })
  })

  it("rw after reserving: input reaches the port; mode switches to ro on expiry; break is holder-only", async () => {
    const c = await start()
    const cl = connect(c, `/ws/console/${consoleId}`, { user: "ana" })
    await cl.wait("history-end")
    cl.ws.send(JSON.stringify({ t: "break", ms: 60 }))
    expect(await cl.wait("input-rejected")).toEqual({ t: "input-rejected", reason: "not-holder" })
    c.reservations.set(eqVisible.id, { id: users.ana.id, name: "ANA" }, "reserve")
    expect(await cl.wait("mode")).toEqual({ t: "mode", mode: "rw", reason: "reserved" })
    cl.ws.send(Buffer.from("root\r"))
    await until(() => c.opener.last(v0.openPath)?.written() === "root\r")
    cl.ws.send(JSON.stringify({ t: "break", ms: 60 }))
    await until(() => (c.opener.last(v0.openPath)?.sets.length ?? 0) === 2)
    c.reservations.set(eqVisible.id, null, "expire")
    expect(await cl.wait("mode", 2)).toEqual({ t: "mode", mode: "ro", reason: "expired" })
    cl.ws.send(Buffer.from("x"))
    expect((await cl.wait("input-rejected", 2)).reason).toBe("not-holder")
    cl.ws.close()
  })

  it("ping → pong; invalid frames → error, then 4002 after 10", async () => {
    const c = await start()
    const cl = connect(c, `/ws/console/${consoleId}`, { user: "ana" })
    await cl.wait("history-end")
    cl.ws.send(JSON.stringify({ t: "ping", at: 42 }))
    expect(await cl.wait("pong")).toMatchObject({ t: "pong", at: 42 })
    for (let i = 0; i < 10; i++) cl.ws.send("{nope")
    expect((await cl.wait("error")).code).toBe("PROTOCOL")
    expect((await cl.closed).code).toBe(4002)
  })

  it("frames over 64 KiB close the socket (maxPayload)", async () => {
    const c = await start()
    const cl = connect(c, `/ws/console/${consoleId}`, { user: "ana" })
    await cl.wait("history-end")
    cl.ws.send(Buffer.alloc(70_000))
    expect((await cl.closed).code).toBe(1009)
  })

  it("session caps: 4 per user per console → the 5th closes 4009", async () => {
    const c = await start()
    const ok = [0, 1, 2, 3].map(() => connect(c, `/ws/console/${consoleId}`, { user: "bea" }))
    await Promise.all(ok.map((x) => x.wait("hello")))
    expect(await connect(c, `/ws/console/${consoleId}`, { user: "bea" }).closed).toEqual({ code: 4009, reason: "Demasiadas sesiones" })
    ok[0].ws.close()
    await ok[0].closed
    await sleep(50)
    const again = connect(c, `/ws/console/${consoleId}`, { user: "bea" })
    expect((await again.wait("hello")).kind).toBe("console")
    for (const x of [...ok, again]) x.ws.close()
  })

  it("clients that leave during the console lookup leak no cap slot and no live session", async () => {
    const c = await start()
    let release = () => {}
    c.lookupGate.hold = new Promise<void>((r) => { release = r })
    for (let i = 1; i <= 5; i++) {
      const gone = connect(c, `/ws/console/${consoleId}`, { user: "bea" })
      expect(await gone.status).toBe(101)
      await until(() => c.lookupGate.entered === i)
      gone.ws.terminate()
      await gone.closed
    }
    await sleep(50)                                     // the server has seen the 5 closes
    c.lookupGate.hold = null
    release()
    await sleep(50)
    expect(c.sessions.count({ userId: users.bea.id })).toBe(0)
    expect(c.serial.consoles.runtime(consoleId)?.viewers).toBe(0)
    const ok = [0, 1, 2, 3].map(() => connect(c, `/ws/console/${consoleId}`, { user: "bea" }))
    await Promise.all(ok.map((x) => x.wait("hello")))      // all 4 slots are still free
    for (const x of ok) x.ws.close()
  })

  it("live sessions: revoke → 4010, expired → 4001, refresh after role loss → 4004", async () => {
    const c = await start()
    const a = connect(c, `/ws/console/${consoleId}`, { user: "ana" })
    await a.wait("hello")
    const live = [...c.sessions.sessions].find((s) => s.userId === users.ana.id && s.kind === "console")
    live?.revoke("revoked")
    expect((await a.closed).code).toBe(4010)
    const b = connect(c, `/ws/console/${consoleId}`, { user: "ana" })
    await b.wait("hello")
    ;[...c.sessions.sessions].find((s) => s.userId === users.ana.id)?.revoke("expired")
    expect((await b.closed).code).toBe(4001)

    const s = connect(c, `/ws/console/${hiddenConsoleId}`, { user: "secret" })
    await s.wait("hello")
    const reg = [...c.sessions.sessions].find((x) => x.userId === users.secret.id)
    reg?.refresh({ ...users.secret, roleIds: [], mustChangePassword: false, sessionVersion: 1 })
    expect((await s.closed).code).toBe(4004)
    await until(() => c.sessions.sessions.size === 0)
  })

  it("a handshake that never completes is destroyed", async () => {
    const c = await start()
    c.authGate.hang = true
    const cl = connect(c, `/ws/console/${consoleId}`, { user: "ana" })
    const t0 = Date.now()
    await Promise.race([cl.closed, cl.status])
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250)
    expect(Date.now() - t0).toBeLessThan(2000)
  })

  it("server stop closes clients with 1001", async () => {
    const c = await start()
    const cl = connect(c, `/ws/console/${consoleId}`, { user: "ana" })
    await cl.wait("hello")
    await c.serial.stop()
    expect(await cl.closed).toEqual({ code: 1001, reason: "Servidor detenido" })
  })
})

describe("preview WebSocket", () => {
  const key = encodeURIComponent(v1.stableKey)

  it("admin only: others get 4004 and an auth.denied audit", async () => {
    const c = await start()
    expect((await connect(c, `/ws/preview/${key}?baud=115200`, { user: "ana" }).closed).code).toBe(4004)
    expect(c.audit.inputs.find((i) => i.action === "auth.denied")).toMatchObject({ outcome: "denied", detail: { operation: "console.preview", code: "FORBIDDEN" } })
  })

  it("streams a free port read-only; input is never written; bound or unknown ports → 4004", async () => {
    const c = await start()
    const cl = connect(c, `/ws/preview/${key}?baud=115200`, { user: "admin" })
    const hello = await cl.wait("hello")
    expect(hello).toMatchObject({ kind: "preview", stableKey: v1.stableKey, devNode: v1.devNode, baudRate: 115200 })
    await cl.wait("history-end")
    const port = c.opener.last(v1.openPath)
    port?.emit("Zynq> ")
    await until(() => Buffer.concat(cl.bin).toString() === "Zynq> ")
    cl.ws.send(Buffer.from("boot\r"))
    await sleep(50)
    expect(port?.writes).toEqual([])
    expect(c.audit.inputs.filter((i) => i.action === "console.preview")).toHaveLength(1)
    expect(c.serial.discovery.toDTO().others.find((p) => p.stableKey === v1.stableKey)?.inUse).toBe("app")

    expect(await connect(c, `/ws/preview/${encodeURIComponent(v0.stableKey)}?baud=115200`, { user: "admin" }).closed).toEqual({ code: 4004, reason: "El puerto está asignado a una consola" })
    expect((await connect(c, `/ws/preview/${encodeURIComponent("virtual:/nope")}?baud=115200`, { user: "admin" }).closed).code).toBe(4004)
    expect(await connect(c, `/ws/preview/${key}?baud=123`, { user: "admin" }).closed).toEqual({ code: 4004, reason: "Velocidad no admitida" })

    // binding a console to the previewed port closes the preview (4004) and opens the console
    const row = await db.prisma.serialConsole.create({ data: { equipmentId: eqVisible.id, position: 1, key: "UART1", label: "UART1", ...bindingFromDevice(v1) } })
    await c.serial.consoles.reloadEquipment(eqVisible.id)
    expect(await cl.closed).toEqual({ code: 4004, reason: `Puerto asignado a ${eqVisible.name} · UART1` })
    expect(port?.closed).toBe(true)
    expect(c.serial.consoles.runtime(row.id)?.status).toBe("open")
    await db.prisma.serialConsole.delete({ where: { id: row.id } })
  })

  // Fix round 2: a socket that goes away while its preview port is still opening must not keep the port (§4.7, §5.7).
  const inUse = (c: Ctx) => c.serial.discovery.toDTO().others.find((p) => p.stableKey === v1.stableKey)?.inUse ?? null
  async function previewLeftDuringOpen(c: Ctx, drop: (cl: Client) => Promise<void>): Promise<void> {
    let release = () => {}
    c.openGate.holds.set(v1.openPath, new Promise<void>((r) => { release = r }))
    const gone = connect(c, `/ws/preview/${key}?baud=115200`, { user: "admin" })
    expect(await gone.status).toBe(101)
    await until(() => c.openGate.entered === 1)
    await drop(gone)
    await gone.closed
    await sleep(50)                                      // the server has seen the close
    c.openGate.holds.delete(v1.openPath)
    release()
    await until(() => c.opener.last(v1.openPath) !== undefined)
    const port = c.opener.last(v1.openPath)
    expect(gone.msgs.find((m) => m.t === "hello")).toBeUndefined()
    await until(() => port?.closed === true, 2000)       // closed on the grace timer, not held for good
    expect(inUse(c)).toBe(null)
    expect(c.sessions.count({ userId: users.admin.id })).toBe(0)
    // No cap slot leaked: the 4 per-user-per-port previews are all still available.
    const ok = [0, 1, 2, 3].map(() => connect(c, `/ws/preview/${key}?baud=115200`, { user: "admin" }))
    await Promise.all(ok.map((x) => x.wait("history-end")))
    for (const x of ok) x.ws.close()
    await Promise.all(ok.map((x) => x.closed))
    const again = c.opener.last(v1.openPath)
    expect(again).not.toBe(port)
    await until(() => again?.closed === true, 2000)
  }

  it("a client that leaves while the preview port is opening does not keep the port open", async () => {
    const c = await start({ openTimeoutMs: 2000, previewGraceMs: 100 })
    await previewLeftDuringOpen(c, async (cl) => { cl.ws.terminate() })
  })

  it("a handshake guard that fires during a slow preview open does not keep the port open", async () => {
    const c = await start({ openTimeoutMs: 2000, previewGraceMs: 100 })
    await previewLeftDuringOpen(c, async (cl) => {
      expect((await cl.closed).code).toBe(1006)            // destroyed by the 300 ms guard, not by the client
    })
  })

  it("a hung preview open gives up after the deadline (4004 with the reason) and never blocks binding the port", async () => {
    const c = await start()
    c.hangOnce.add(v1.openPath)
    const cl = connect(c, `/ws/preview/${key}?baud=115200`, { user: "admin" })
    expect(await cl.status).toBe(101)
    await sleep(30)
    const row = await db.prisma.serialConsole.create({ data: { equipmentId: eqVisible.id, position: 1, key: "UART1", label: "UART1", ...bindingFromDevice(v1) } })
    const t0 = Date.now()
    await c.serial.consoles.reloadEquipment(eqVisible.id)     // waits for the preview's open, now bounded
    expect(Date.now() - t0).toBeLessThan(2000)
    expect(await cl.closed).toEqual({ code: 4004, reason: "No se pudo abrir el puerto: Tiempo de espera agotado al abrir el puerto" })
    await until(() => c.serial.consoles.runtime(row.id)?.status === "open")
    await db.prisma.serialConsole.delete({ where: { id: row.id } })
  })
})
