// Access service integration: real DB, real sockets, the fake hw_server script, fake cables and consoles.
import net from "node:net"
import path from "node:path"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import type { ConsoleRuntimeDTO } from "@/lib/contracts/serial"
import type { AccessServices, ConsoleTap, SerialServices } from "@/server/runtime/types"
import { createNullLogger } from "@/server/log"
import { TestReservations } from "@/server/serial/testing/fakes"
import { createTestDb, fakeAudit, fakeBus, fakeRuntime, fakeSettings, testConfig, withTempDir, type TestDb } from "../../../test/helpers"
import { createAccessServices } from "./index"
import type { JtagCable } from "./jtag-enumerate"

const FAKE_HW = path.resolve(__dirname, "../../../scripts/sim/fake-hw-server.mjs")
let db: TestDb
beforeAll(async () => { db = await createTestDb() })
afterAll(async () => { await db.cleanup() })

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer()
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port
      s.close(() => resolve(p))
    })
  })
}
const until = async (fn: () => boolean | Promise<boolean>, ms = 8000) => {
  const end = Date.now() + ms
  while (!(await fn())) {
    if (Date.now() > end) throw new Error("timeout")
    await new Promise((r) => setTimeout(r, 25))
  }
}
function read(port: number, send?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host: "127.0.0.1", port })
    let buf = ""
    s.on("data", (d) => (buf += d.toString()))
    s.once("connect", () => { if (send) s.write(send) })
    s.once("error", reject)
    setTimeout(() => { s.destroy(); resolve(buf) }, 300)
  })
}
const refused = (port: number) => new Promise<boolean>((resolve) => {
  const s = net.connect({ host: "127.0.0.1", port })
  s.once("connect", () => { s.destroy(); resolve(false) })
  s.once("error", () => resolve(true))
})

const openRt: ConsoleRuntimeDTO = { status: "open", devNode: "/dev/ttyV0", detail: null, since: new Date().toISOString(), lastRxAt: null, lastLine: null, viewers: 0, released: null, capture: "active" }

let tmp: { dir: string; cleanup: () => void } | null = null
let svc: AccessServices | null = null
let echo: net.Server | null = null
beforeEach(async () => {
  await db.prisma.equipmentAccess.deleteMany()
  await db.prisma.cableLabel.deleteMany()
  await db.prisma.serialConsole.deleteMany()
  await db.prisma.equipment.deleteMany()
})
afterEach(async () => {
  await svc?.stop()
  svc = null
  await new Promise<void>((r) => (echo ? echo.close(() => r()) : r()))
  echo = null
  tmp?.cleanup()
  tmp = null
})

async function setup() {
  tmp = withTempDir("rm-acc-")
  const ports = { jtag: await freePort(), serial: await freePort(), tcp: await freePort(), target: 0 }
  echo = net.createServer((c) => c.on("data", (d) => c.write(Buffer.concat([Buffer.from("eco:"), d]))))
  ports.target = await new Promise<number>((r) => echo?.listen(0, "127.0.0.1", () => r((echo?.address() as net.AddressInfo).port)))
  const eq = await db.prisma.equipment.create({ data: { name: "Equipo A #01" } })
  const con = await db.prisma.serialConsole.create({ data: { equipmentId: eq.id, position: 0, key: "UART0", label: "UART0" } })
  await db.prisma.equipmentAccess.createMany({
    data: [
      { equipmentId: eq.id, position: 0, key: "JTAG0", label: "JTAG 0", kind: "jtag", port: ports.jtag, jtagCableSerial: "210299ABCDEF" },
      { equipmentId: eq.id, position: 1, key: "SERIE0", label: "Serie 0", kind: "serial", port: ports.serial, consoleId: con.id },
      { equipmentId: eq.id, position: 2, key: "ETH", label: "Ethernet", kind: "tcp", port: ports.tcp, targetHost: "127.0.0.1", targetPort: ports.target },
    ],
  })
  await db.prisma.cableLabel.create({ data: { kind: "jtag", identity: "210299ABCDEF", name: "JTAG-07" } })
  const taps = new Set<ConsoleTap>()
  const writes: string[] = []
  const base = fakeRuntime()
  const serial: SerialServices = {
    ...base.serial,
    consoles: {
      ...base.serial.consoles,
      runtime: (id) => (id === con.id ? openRt : null),
      attachTap: (_id, tap) => { taps.add(tap); return { history: Buffer.from("U-Boot\r\n"), runtime: openRt, key: "UART0", label: "UART0", equipmentName: eq.name } },
      detachTap: (_id, tap) => { taps.delete(tap) },
      writeFromTap: (_id, b) => { writes.push(b.toString()); return "ok" },
    },
  }
  const cables: JtagCable[] = []
  const reservations = new TestReservations()
  const bus = fakeBus()
  const audit = fakeAudit()
  const base0 = testConfig({ dataDir: tmp.dir })
  // Random free ports in the tests: the whole unprivileged range is "RM_ACCESS_PORTS".
  const config = { ...base0, accesses: { ...base0.accesses, range: { from: 1024, to: 65535 } } }
  svc = createAccessServices(
    { config, log: createNullLogger(), prisma: db.prisma, bus, audit, settings: fakeSettings(), reservations, serial, equipnet: fakeRuntime().equipnet },
    {
      scanJtag: async () => cables, jtagPollMs: 50, connPollMs: 100, retryMs: 200,
      hwServer: () => ({ path: FAKE_HW, version: null, source: "config", problem: null }),
      supervisor: { startTimeoutMs: 8000, backoffMs: [200], killGraceMs: 1000, pollMs: 50 },
    },
  )
  const hs3: JtagCable = { serial: "210299ABCDEF", vendorId: "0403", productId: "6014", manufacturer: "Digilent", product: "Digilent USB Device", family: "digilent", busnum: 1, devnum: 5, portPath: "1-2", location: "USB 1-2" }
  const status = (key: string) => {
    const a = svc ? Object.entries(svc.runtimeForEquipment(eq.id)) : []
    return a.length ? svc?.runtime(a[["JTAG0", "SERIE0", "ETH"].indexOf(key)][0])?.status : undefined
  }
  return { eq, con, ports, taps, writes, cables, hs3, reservations, bus, audit, status }
}

describe("createAccessServices", () => {
  it("reserved policy: closed until reserved; then hw_server with the cable filter, the serial bridge and the forward; closed again on release", async () => {
    const h = await setup()
    await svc?.start()
    // What blocks an access shows even before reserving (the cable is not plugged in); the rest wait for the reservation.
    expect(h.status("JTAG0")).toBe("cable-missing")
    expect(await refused(h.ports.serial)).toBe(true)
    expect(await refused(h.ports.tcp)).toBe(true)
    const rt1 = Object.values(svc?.runtimeForEquipment(h.eq.id) ?? {})[1]
    expect(rt1).toMatchObject({ status: "stopped", reason: "not-reserved", detail: "Reserva el equipo para abrir los accesos." })

    // Reserved, cable absent: the JTAG access waits for the cable; the others open.
    h.reservations.set(h.eq.id, { id: "u1", name: "Ana" }, "reserve")
    await until(() => h.status("SERIE0") === "listening" && h.status("ETH") === "listening")
    expect(h.status("JTAG0")).toBe("cable-missing")
    expect(svc?.runtime(Object.keys(svc.runtimeForEquipment(h.eq.id))[0])?.detail).toMatch(/JTAG-07/)

    // Plug the cable: hw_server starts on the access port with -p0 and the cable filter.
    h.cables.push(h.hs3)
    await until(() => h.status("JTAG0") === "listening")
    expect(await read(h.ports.jtag)).toBe(`fake-hw_server port=${h.ports.jtag} jtag-port-filter=210299ABCDEF gdb=0\n`)
    expect(svc?.jtag().cables.map((c) => [c.serial, c.labelName, c.assignedTo.map((a) => a.key)])).toEqual([["210299ABCDEF", "JTAG-07", ["JTAG0"]]])

    // Serial: history, then input goes to the console; TCP forward reaches the target.
    const text = await read(h.ports.serial, "root\n")
    expect(text).toMatch(/Relay Manager · Equipo A #01 · UART0 · escritura permitida/)
    expect(text).toMatch(/U-Boot/)
    await until(() => h.writes.includes("root\n"))
    expect(h.reservations.touches).toContainEqual({ equipmentId: h.eq.id, userId: "u1" })
    expect(await read(h.ports.tcp, "hola")).toBe("eco:hola")

    const actions = h.audit.inputs.map((i) => i.action)
    expect(actions.filter((a) => a === "access.start")).toHaveLength(3)
    expect(actions).toContain("access.connect")
    expect(h.bus.events.some((e) => e.event.type === "access.status")).toBe(true)

    // Release: everything closes, hw_server stops.
    h.reservations.set(h.eq.id, null, "release")
    await until(() => h.status("JTAG0") === "stopped" && h.status("SERIE0") === "stopped" && h.status("ETH") === "stopped")
    await until(async () => (await refused(h.ports.jtag)) && (await refused(h.ports.serial)) && (await refused(h.ports.tcp)))
    expect(h.audit.inputs.filter((i) => i.action === "access.stop")).toHaveLength(3)
  }, 30_000)

  it("established connections (JTAG via the kernel table, idle serial and Ethernet sessions) keep the reservation alive", async () => {
    const h = await setup()
    h.cables.push(h.hs3)
    h.reservations.set(h.eq.id, { id: "u1", name: "Ana" }, "reserve")
    await svc?.start()
    await until(() => h.status("JTAG0") === "listening" && h.status("SERIE0") === "listening" && h.status("ETH") === "listening")
    const idle = async () => {
      h.reservations.touches.splice(0)
      await new Promise((r) => setTimeout(r, 400))
      return h.reservations.touches.length === 0
    }
    // Nobody connected: nothing renews the reservation.
    expect(await idle()).toBe(true)

    const hold = (port: number) => new Promise<net.Socket>((resolve, reject) => {
      const s = net.connect({ host: "127.0.0.1", port }, () => resolve(s))
      s.on("data", () => {})
      s.once("error", reject)
    })
    const ids = Object.keys(svc?.runtimeForEquipment(h.eq.id) ?? {})
    // xsdb connected to hw_server and quiet (no web activity, no bytes seen by us): the poll renews the reservation.
    const jtag = await hold(h.ports.jtag)
    await until(() => (svc?.runtime(ids[0])?.connections.length ?? 0) === 1)
    h.reservations.touches.splice(0)
    await until(() => h.reservations.touches.some((t) => t.equipmentId === h.eq.id && t.userId === "u1"))
    jtag.destroy()
    await until(() => svc?.runtime(ids[0])?.connections.length === 0)
    expect(await idle()).toBe(true)

    // A serial session that only watches and an idle Ethernet (ssh) session count too.
    for (const port of [h.ports.serial, h.ports.tcp]) {
      const s = await hold(port)
      h.reservations.touches.splice(0)
      await until(() => h.reservations.touches.some((t) => t.equipmentId === h.eq.id && t.userId === "u1"))
      s.destroy()
      await until(() => Object.values(svc?.runtimeForEquipment(h.eq.id) ?? {}).every((r) => r.connections.length === 0))
    }
    expect(await idle()).toBe(true)

    // Without a reservation ("always" accesses stay open) connections renew nothing.
    await db.prisma.equipmentAccess.updateMany({ data: { policy: "always" } })
    await svc?.reloadEquipment(h.eq.id)
    h.reservations.set(h.eq.id, null, "release")
    await until(() => h.status("SERIE0") === "listening")
    const s = await hold(h.ports.serial)
    await until(() => (svc?.runtime(ids[1])?.connections.length ?? 0) === 1)
    expect(await idle()).toBe(true)
    s.destroy()
  }, 30_000)

  it("label changes reach admins only (they name every equipment that uses a cable); a malformed cable serial never reaches hw_server", async () => {
    const h = await setup()
    await svc?.start()
    await svc?.reloadLabels()
    const labelEvents = h.bus.events.filter((e) => e.event.type === "cable-labels.changed" || e.event.type === "jtag.changed")
    expect(labelEvents.length).toBeGreaterThan(0)
    expect(labelEvents.every((e) => e.audience.kind === "admins")).toBe(true)

    // A serial that would inject hw_server commands ("-e" is a Tcl command line) is refused before spawning.
    const jtagId = (await db.prisma.equipmentAccess.findFirstOrThrow({ where: { key: "JTAG0" } })).id
    const bad = "210299ABCDEF; exit"
    await db.prisma.equipmentAccess.update({ where: { id: jtagId }, data: { jtagCableSerial: bad } })
    h.cables.push({ ...h.hs3, serial: bad })
    h.reservations.set(h.eq.id, { id: "u1", name: "Ana" }, "reserve")
    await svc?.reloadEquipment(h.eq.id)
    await until(() => svc?.runtime(jtagId)?.status === "error")
    expect(svc?.runtime(jtagId)?.pid).toBeNull()
    expect(await refused(h.ports.jtag)).toBe(true)
  }, 30_000)

  it("a client that connects in a loop cannot flood the audit log", async () => {
    const h = await setup()
    h.reservations.set(h.eq.id, { id: "u1", name: "Ana" }, "reserve")
    await svc?.start()
    await until(() => h.status("ETH") === "listening")
    for (let i = 0; i < 60; i++) {
      await new Promise<void>((resolve) => {
        const s = net.connect({ host: "127.0.0.1", port: h.ports.tcp }, () => { s.destroy(); resolve() })
        s.once("error", () => resolve())
      })
    }
    await new Promise((r) => setTimeout(r, 300))
    const rows = h.audit.inputs.filter((i) => i.action === "access.connect" || i.action === "access.disconnect")
    expect(rows.length).toBeGreaterThanOrEqual(10)
    expect(rows.length).toBeLessThanOrEqual(20)
  }, 30_000)

  it("two equipment in parallel: one hw_server per cable on its own port and filter; a crash restarts only that one", async () => {
    const h = await setup()
    const eq2 = await db.prisma.equipment.create({ data: { name: "Equipo A #02" } })
    const port2 = await freePort()
    await db.prisma.equipmentAccess.create({ data: { equipmentId: eq2.id, position: 0, key: "JTAG0", label: "JTAG 0", kind: "jtag", port: port2, jtagCableSerial: "210299FEDCBA" } })
    h.cables.push(h.hs3, { ...h.hs3, serial: "210299FEDCBA", portPath: "1-3", location: "USB 1-3", devnum: 6 })
    h.reservations.set(h.eq.id, { id: "u1", name: "Ana" }, "reserve")
    h.reservations.set(eq2.id, { id: "u2", name: "Luis" }, "reserve")
    await svc?.start()
    const id1 = (await db.prisma.equipmentAccess.findFirstOrThrow({ where: { equipmentId: h.eq.id, key: "JTAG0" } })).id
    const id2 = (await db.prisma.equipmentAccess.findFirstOrThrow({ where: { equipmentId: eq2.id } })).id
    await until(() => svc?.runtime(id1)?.status === "listening" && svc.runtime(id2)?.status === "listening")
    expect(await read(h.ports.jtag)).toBe(`fake-hw_server port=${h.ports.jtag} jtag-port-filter=210299ABCDEF gdb=0\n`)
    expect(await read(port2)).toBe(`fake-hw_server port=${port2} jtag-port-filter=210299FEDCBA gdb=0\n`)
    const pid1 = svc?.runtime(id1)?.pid
    const pid2 = svc?.runtime(id2)?.pid
    expect(pid1 && pid2 && pid1 !== pid2).toBeTruthy()

    // hw_server of #01 dies: error with the cause, restarted after the backoff; #02 never notices.
    process.kill(pid1 as number, "SIGKILL")
    await until(() => svc?.runtime(id1)?.status === "error")
    expect(svc?.runtime(id1)?.detail).toMatch(/hw_server/)
    await until(() => svc?.runtime(id1)?.status === "listening" && svc.runtime(id1)?.pid !== pid1)
    expect(svc?.runtime(id2)).toMatchObject({ status: "listening", pid: pid2 })

    // Releasing #01 closes only #01.
    h.reservations.set(h.eq.id, null, "expire")
    await until(async () => svc?.runtime(id1)?.status === "stopped" && (await refused(h.ports.jtag)))
    expect(svc?.runtime(id2)?.status).toBe("listening")
    expect(await read(port2)).toMatch(/210299FEDCBA/)
  }, 30_000)

  it("unplugging the cable stops hw_server; replugging (another USB port) starts it again; policy always needs no reservation", async () => {
    const h = await setup()
    await db.prisma.equipmentAccess.updateMany({ data: { policy: "always" } })
    h.cables.push(h.hs3)
    await svc?.start()
    await until(() => h.status("JTAG0") === "listening" && h.status("SERIE0") === "listening")
    // "always" serial without a reservation: read-only.
    const t = await read(h.ports.serial, "reboot\n")
    expect(t).toMatch(/solo lectura/)
    expect(h.writes).toEqual([])
    h.cables.splice(0)
    await until(() => h.status("JTAG0") === "cable-missing")
    expect(await refused(h.ports.jtag)).toBe(true)
    h.cables.push({ ...h.hs3, portPath: "1-4", location: "USB 1-4" })
    await until(() => h.status("JTAG0") === "listening")
  }, 30_000)

  it("a port held by another program is reported and retried; portState tells free, busy and ours", async () => {
    const h = await setup()
    await db.prisma.equipmentAccess.updateMany({ data: { policy: "always" } })
    const blocker = net.createServer()
    await new Promise<void>((r) => blocker.listen(h.ports.serial, "127.0.0.1", () => r()))
    await svc?.start()
    await until(() => h.status("SERIE0") === "port-busy")
    const ids = Object.keys(svc?.runtimeForEquipment(h.eq.id) ?? {})
    expect(await svc?.portState(h.ports.serial, null)).toBe("busy")
    expect(h.audit.inputs.some((i) => i.action === "access.error")).toBe(true)
    await new Promise<void>((r) => blocker.close(() => r()))
    await until(() => h.status("SERIE0") === "listening")
    expect(await svc?.portState(h.ports.serial, ids[1])).toBe("ours")
    expect(await svc?.portState(await freePort(), null)).toBe("free")
  }, 30_000)

  it("without hw_server the JTAG access says so; reloadEquipment applies config changes", async () => {
    const h = await setup()
    svc = createAccessServices(
      { config: { ...testConfig({ dataDir: tmp?.dir ?? "/tmp" }), accesses: { ...testConfig().accesses, range: { from: 1024, to: 65535 } } }, log: createNullLogger(), prisma: db.prisma, bus: fakeBus(), audit: fakeAudit(), settings: fakeSettings(), reservations: h.reservations, serial: fakeRuntime().serial, equipnet: fakeRuntime().equipnet },
      { scanJtag: async () => [h.hs3], jtagPollMs: 50, hwServer: () => ({ path: null, version: null, source: null, problem: "No se encuentra hw_server." }) },
    )
    h.reservations.set(h.eq.id, { id: "u1", name: "Ana" }, "reserve")
    await svc.start()
    const jtagId = (await db.prisma.equipmentAccess.findFirstOrThrow({ where: { key: "JTAG0" } })).id
    await until(() => svc?.runtime(jtagId)?.status === "hw-server-missing")
    expect(svc.runtime(jtagId)?.detail).toBe("No se encuentra hw_server.")
    await db.prisma.equipmentAccess.update({ where: { id: jtagId }, data: { enabled: false } })
    await svc.reloadEquipment(h.eq.id)
    expect(svc.runtime(jtagId)).toMatchObject({ status: "stopped", reason: "disabled" })
    await db.prisma.equipmentAccess.delete({ where: { id: jtagId } })
    await svc.reloadEquipment(h.eq.id)
    expect(svc.runtime(jtagId)).toBeNull()
    // RM_ACCESS_PORTS changed after the access was created: it does not open outside the range (the firewall's).
    const serialId = (await db.prisma.equipmentAccess.findFirstOrThrow({ where: { key: "SERIE0" } })).id
    await db.prisma.equipmentAccess.update({ where: { id: serialId }, data: { port: 1000 } })
    await svc.reloadEquipment(h.eq.id)
    expect(svc.runtime(serialId)).toMatchObject({ status: "error" })
    expect(svc.runtime(serialId)?.detail).toMatch(/1000.*RM_ACCESS_PORTS/)
  }, 30_000)
})
