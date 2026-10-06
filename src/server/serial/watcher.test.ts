import fs from "node:fs"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { withTempDir } from "../../../test/helpers/temp"
import { SysfsFixture } from "../../../test/fixtures/sysfs"
import { scanSerialPorts } from "./enumerate"
import { SerialDiscoveryImpl, type DiscoveryEvent } from "./watcher"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

let tmp: { dir: string; cleanup: () => void }
let disc: SerialDiscoveryImpl | null = null
beforeEach(() => { tmp = withTempDir("rm-watch-") })
afterEach(() => { disc?.stop(); disc = null; tmp.cleanup() })

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timeout")
    await sleep(20)
  }
}

function setup(f: SysfsFixture, o: { extra?: string[]; intervalMs?: number; settleMs?: number; watch?: ConstructorParameters<typeof SerialDiscoveryImpl>[0]["watch"] } = {}) {
  const events: DiscoveryEvent[] = []
  const extra = o.extra ?? []
  disc = new SerialDiscoveryImpl({
    scan: () => scanSerialPorts({ sysRoot: f.sysRoot, devRoot: f.devRoot, extraGlobs: extra, includeBuiltin: false }),
    devRoot: f.devRoot,
    extraDirs: extra.map((g) => path.dirname(g)),
    intervalMs: o.intervalMs ?? 100,
    settleMs: o.settleMs ?? 300,
    debounceMs: 50,
    watch: o.watch,
    onChange: (evs) => { events.push(...evs) },
  })
  return { events, disc }
}

describe("SerialDiscoveryImpl", () => {
  it("adapters present at start are in the snapshot at once and emit no event", async () => {
    const f = SysfsFixture.standard(tmp.dir)
    const { events, disc } = setup(f)
    await disc.start()
    expect(disc.adapters()).toHaveLength(6)
    expect(disc.find("usb:0403:6011:FT4ABCDE:if2:p0")?.name).toBe("ttyUSB2")
    await sleep(250)
    expect(events).toEqual([])
  })

  it("an FT4232H appearing over 4 staggered nodes → one adapter-added (after settle); unplug → removed", async () => {
    const f = new SysfsFixture(tmp.dir)
    const { events, disc } = setup(f)
    await disc.start()
    const dev = f.addUsbDevice({ port: "3.1", vendorId: "0403", productId: "6011", manufacturer: "FTDI", product: "Quad RS232-HS", serial: "FT4ABCDE", numInterfaces: 4 })
    for (let i = 0; i < 4; i++) {
      const ifd = f.addInterface(dev, i, "ftdi_sio")
      f.addUsbSerialTty(ifd, `ttyUSB${i}`, 0, "ftdi_sio")
      await sleep(90)
    }
    expect(disc.adapters()).toHaveLength(0)            // not announced before it settles
    await until(() => events.length > 0)
    await sleep(400)
    expect(events.map((e) => e.kind)).toEqual(["adapter-added"])
    expect(events[0].adapter?.ports.map((p) => p.name)).toEqual(["ttyUSB0", "ttyUSB1", "ttyUSB2", "ttyUSB3"])
    expect(events[0].label).toBe("Nuevo adaptador: FTDI Quad RS232-HS (FT4ABCDE), 4 puertos")
    expect(disc.adapters()).toHaveLength(1)

    f.removeUsbDevice(dev)
    await until(() => events.length > 1)
    await sleep(200)
    expect(events.map((e) => e.kind)).toEqual(["adapter-added", "adapter-removed"])
    expect(events[1].label).toBe("Adaptador desconectado: FTDI Quad RS232-HS (FT4ABCDE)")
    expect(disc.adapters()).toHaveLength(0)
  })

  it("JTAG if00 flap (hw_server detaches it) → adapter-changed, not remove + add", async () => {
    const f = new SysfsFixture(tmp.dir)
    f.addUsbSerialAdapter(
      { port: "2", vendorId: "0403", productId: "6010", manufacturer: "Digilent", product: "Digilent Adept USB Device", serial: "210251A0B1C2", numInterfaces: 2 },
      [{ iface: 0, tty: "ttyUSB0", driver: "ftdi_sio" }, { iface: 1, tty: "ttyUSB1", driver: "ftdi_sio" }],
    )
    const { events, disc } = setup(f)
    await disc.start()
    f.removeTty("ttyUSB0")
    await until(() => events.length > 0)
    expect(events.map((e) => e.kind)).toEqual(["adapter-changed"])
    expect(events[0].adapter?.ports.map((p) => p.name)).toEqual(["ttyUSB1"])
    expect(disc.find("usb:0403:6010:210251A0B1C2:if1:p0")?.name).toBe("ttyUSB1")
  })

  it("pty via extra glob → port-added / port-removed (no settle); a re-created link is re-announced", async () => {
    const f = new SysfsFixture(tmp.dir)
    const sim = path.join(tmp.dir, "sim")
    fs.mkdirSync(sim)
    const glob = path.join(sim, "ttyV*")
    const { events, disc } = setup(f, { extra: [glob], intervalMs: 5000 })   // only the dir watch can see it quickly
    await disc.start()
    fs.writeFileSync(path.join(tmp.dir, "pts5"), "")
    fs.writeFileSync(path.join(tmp.dir, "pts6"), "")
    fs.symlinkSync(path.join(tmp.dir, "pts5"), path.join(sim, "ttyV0"))
    await until(() => events.length > 0, 1500)
    expect(events[0]).toMatchObject({ kind: "port-added", label: `Nuevo puerto: ${path.join(sim, "ttyV0")}` })
    expect(disc.inotify()).toBe(true)

    // fake console restarted: same link, new pty
    fs.rmSync(path.join(sim, "ttyV0"))
    fs.symlinkSync(path.join(tmp.dir, "pts6"), path.join(sim, "ttyV0"))
    await until(() => events.length >= 3, 1500)
    expect(events.slice(1).map((e) => e.kind)).toEqual(["port-removed", "port-added"])

    fs.rmSync(path.join(sim, "ttyV0"))
    await until(() => events.length >= 4, 1500)
    expect(events[3]).toMatchObject({ kind: "port-removed" })
    expect(disc.others()).toEqual([])
  })

  it("a pending earlier scan is never postponed by later kicks", async () => {
    const f = new SysfsFixture(tmp.dir)
    const scans: number[] = []
    let kick: ((name: string | null) => void) | null = null
    disc = new SerialDiscoveryImpl({
      scan: async () => { scans.push(Date.now()); return [] },
      devRoot: f.devRoot, extraDirs: [], intervalMs: 60_000, settleMs: 300, debounceMs: 300,
      watch: (_dir, cb) => { kick = cb; return { close() {} } },
      onChange: () => {},
    })
    await disc.start()
    scans.length = 0
    const t0 = Date.now()
    const fire = kick as ((name: string | null) => void) | null
    for (let i = 0; i < 10; i++) {
      fire?.("ttyUSB0")
      await sleep(100)
    }
    expect(scans.length).toBeGreaterThanOrEqual(2)
    expect(scans[0] - t0).toBeLessThan(450)
  })

  it("ignores /dev entries that are not serial nodes", async () => {
    const f = new SysfsFixture(tmp.dir)
    let scansCount = 0
    let kick: ((name: string | null) => void) | null = null
    disc = new SerialDiscoveryImpl({
      scan: async () => { scansCount++; return [] },
      devRoot: f.devRoot, extraDirs: [], intervalMs: 60_000, settleMs: 300, debounceMs: 30,
      watch: (_dir, cb) => { kick = cb; return { close() {} } },
      onChange: () => {},
    })
    await disc.start()
    const n = scansCount
    const fire = kick as ((name: string | null) => void) | null
    fire?.("sda1")
    fire?.("loop3")
    await sleep(120)
    expect(scansCount).toBe(n)
    fire?.("serial")
    await sleep(120)
    expect(scansCount).toBe(n + 1)
  })

  it("a missing /dev/serial does not break discovery", async () => {
    const f = SysfsFixture.standard(tmp.dir)
    f.removeSerialLinks()
    const { disc } = setup(f)
    await disc.start()
    expect(disc.adapters()).toHaveLength(6)
  })

  it("fs.watch failure → polling only (inotify false) and hot-plug still works", async () => {
    const f = new SysfsFixture(tmp.dir)
    const { events, disc } = setup(f, {
      intervalMs: 100, settleMs: 100,
      watch: () => { const e = new Error("ENOSPC") as NodeJS.ErrnoException; e.code = "ENOSPC"; throw e },
    })
    await disc.start()
    expect(disc.inotify()).toBe(false)
    f.addFt4232h("3.1", "FT4ABCDE", 0, [0])
    await until(() => events.length > 0)
    expect(events[0].kind).toBe("adapter-added")
  })

  it("scanNow() runs a scan right away and reports the time", async () => {
    const f = new SysfsFixture(tmp.dir)
    const { disc } = setup(f, { intervalMs: 60_000, settleMs: 0 })
    await disc.start()
    const before = disc.scannedAt().getTime()
    f.addCh340("5", "ttyUSB6")
    await sleep(5)
    await disc.scanNow()
    expect(disc.scannedAt().getTime()).toBeGreaterThan(before)
    expect(disc.adapters()).toHaveLength(1)
  })
})
