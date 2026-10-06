import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createFakeSwitch, type FakeSwitch } from "../../../scripts/sim/fake-tplink-switch.mjs"
import type { EquipnetServices } from "@/server/runtime/types"
import { createNullLogger } from "@/server/log"
import { createTestDb, fakeAudit, fakeBus, fakeSettings, testConfig, type TestDb } from "../../../test/helpers"
import { createEquipnetServices } from "./index"
import { httpRequest, type HttpFn } from "./http-client"
import type { HostState } from "./host-plan"
import type { NetIface } from "./sysfs"
import { FakeKernel } from "./testing/fake-kernel"

const USB: NetIface = {
  ifname: "enx08beac3882ce", mac: "08:be:ac:38:82:ce", usb: true, bus: "usb", wireless: false, driver: "cdc_ncm", vendorId: "0b95", productId: "1790",
  manufacturer: "ASIX", product: "AX88179A", serial: "0000000000008B", location: "USB 2-3", carrier: true, operUp: true, speedMbps: 1000,
}
const PCI = { usb: false, bus: "pci" as const, vendorId: null, productId: null, manufacturer: null, product: null, serial: null, location: null }
/** The lab network (172.x, default route). */
const LAB: NetIface = { ...USB, ...PCI, ifname: "enp3s0", mac: "2c:58:b9:d1:c6:57", driver: "r8169" }
/** Another network of the bench PC on 192.168.1.0/24 (the equipment subnet!), with its own 192.168.1.10 behind it. */
const OTHER: NetIface = { ...USB, ...PCI, ifname: "enp4s0", mac: "2c:58:b9:d1:c6:58", driver: "e1000e" }
const link = (i: NetIface) => ({ ifname: i.ifname, up: true, kind: null, vlanId: null, parent: null, mac: i.mac })
const KERNEL: HostState = {
  links: [{ ifname: "lo", up: true, kind: null, vlanId: null, parent: null, mac: null }, link(LAB), link(OTHER), link(USB)],
  addrs: [
    { ifname: "lo", local: "127.0.0.1", prefixlen: 8 }, { ifname: LAB.ifname, local: "172.20.5.50", prefixlen: 16 },
    { ifname: OTHER.ifname, local: "192.168.1.203", prefixlen: 24 },
  ],
  rules: [{ priority: 0, src: "all", srclen: null, table: "local" }, { priority: 32766, src: "all", srclen: null, table: "main" }],
  routes: [
    { table: "main", dst: "default", dev: LAB.ifname }, { table: "main", dst: "172.20.0.0/16", dev: LAB.ifname },
    { table: "main", dst: "192.168.1.0/24", dev: OTHER.ifname },
  ],
}
const ADMIN = { kind: "user" as const, id: "u1", name: "admin", ip: "10.0.0.1" }

let db: TestDb
let sw: FakeSwitch
let kernel: FakeKernel
let svc: EquipnetServices | null = null
let nics: NetIface[]
let probes: Array<{ host: string; source: string | null }>
const audit = fakeAudit()
const bus = fakeBus()

/** The switch "lives" at 192.168.0.99:80: requests there go to the fake switch. */
const httpTo = (): HttpFn => (r) => (r.host === "192.168.0.99" ? httpRequest({ ...r, host: "127.0.0.1", port: sw.port, localAddress: null }) : Promise.reject(new Error("sin ruta")))

let labelReloads = 0
async function start(o: { cap?: boolean; arpIgnore?: string; equipmentIp?: string | null } = {}): Promise<EquipnetServices> {
  labelReloads = 0
  const base = testConfig()
  const s = createEquipnetServices(
    {
      config: testConfig({
        dataDir: db.dir, net: { ...base.net, hostMode: "apply" },
        defaults: { ...base.defaults, equipmentIp: o.equipmentIp === undefined ? base.defaults.equipmentIp : o.equipmentIp },
      }), log: createNullLogger(), prisma: db.prisma, bus, audit, settings: fakeSettings() },
    {
      scanNet: async () => nics, readHost: kernel.read, runIp: kernel.run, routeGet: kernel.routeGet, ipBinary: () => "/usr/sbin/ip", hasCap: () => o.cap ?? true,
      defaultRoutes: () => [LAB.ifname], http: httpTo(), nmDevices: async () => ({ [LAB.ifname]: { state: "connected", connection: "Laboratorio" } }),
      sysctl: (k) => (k.endsWith("arp_ignore") ? o.arpIgnore ?? "0" : "0"),
      tcpOpen: async (host, _port, source) => {
        probes.push({ host, source })
        return host === "192.168.0.99"
      },
      adapterPollMs: 60_000, reconcileMs: 60_000, switchPollMs: 60_000,
      onLabelsChanged: async () => { labelReloads++ },
    },
  )
  await s.start()
  svc = s
  return s
}
/** The saved settings as a save input (the equipment IP is set in these tests). */
const settingsOf = (s: EquipnetServices) => ({ ...s.settings(), equipmentIp: s.settings().equipmentIp ?? "" })
async function until(f: () => boolean, ms = 8000): Promise<void> {
  const t = Date.now()
  while (!f()) {
    if (Date.now() - t > ms) throw new Error("tiempo agotado")
    await new Promise((r) => setTimeout(r, 25))
  }
}
/** Everything the kernel has about an interface (addresses, routes by device), to compare before/after. */
const aboutIf = (st: HostState, ifname: string) => JSON.stringify([st.links.find((l) => l.ifname === ifname), st.addrs.filter((a) => a.ifname === ifname), st.routes.filter((r) => r.dev === ifname)])
const untouched = (ifname: string) => expect(aboutIf(kernel.state, ifname)).toBe(aboutIf(KERNEL, ifname))

beforeEach(async () => {
  db = await createTestDb()
  sw = await createFakeSwitch({ links: [1, 3] })
  kernel = new FakeKernel(KERNEL)
  nics = [USB, LAB, OTHER]
  probes = []
})
afterEach(async () => {
  await svc?.stop()
  svc = null
  await sw.close()
  await db.cleanup()
})

describe("Red de equipos: nothing happens until the admin chooses the interface", () => {
  it("lists every interface, never adds an address, never scans, only a passive card", async () => {
    const s = await start()
    await s.reconcileNow(ADMIN)
    await new Promise((r) => setTimeout(r, 100))
    expect(kernel.ran).toEqual([])
    expect(probes).toEqual([])
    const st = s.status()
    expect(st.offerSetup).toBe(true)
    expect(st.detection).toBeNull()
    expect(st.host).toMatchObject({ state: "off", pending: [] })
    const by = Object.fromEntries(st.adapters.map((a) => [a.ifname, a]))
    expect(by[LAB.ifname]).toMatchObject({ selectable: "no", defaultRoute: true, nmState: "connected", nmConnection: "Laboratorio", bus: "pci" })
    expect(by[LAB.ifname]?.problem).toMatch(/ruta por defecto/)
    expect(by[OTHER.ifname]).toMatchObject({ selectable: "confirm", addresses: ["192.168.1.203/24"] })
    expect(by[OTHER.ifname]?.warning).toMatch(/otra red \(192\.168\.1\.203\/24\).*No es un adaptador USB|No es un adaptador USB.*otra red/)
    expect(by[USB.ifname]).toMatchObject({ selectable: "yes", problem: null, warning: null, mgmtReuse: null })
    expect(s.health().find((h) => h.id === "equipnet.adapter")?.message).toMatch(/sin configurar/i)
    // Without an interface the switch is never polled, even with an IP stored.
    await expect(s.discover(null, ADMIN)).rejects.toMatchObject({ code: "VALIDATION", message: expect.stringMatching(/Elige primero la interfaz/) })
    await expect(s.saveSettings({ ...settingsOf(s), enabled: true, switchHost: "192.168.0.99" }, ADMIN)).rejects.toMatchObject({ code: "VALIDATION" })
    expect(kernel.ran).toEqual([])
    expect(probes).toEqual([])
  })

  it("the default route's interface can never be chosen; one with another network's address needs a confirmation", async () => {
    const s = await start()
    await expect(s.chooseAdapter({ mac: LAB.mac, confirmed: true }, ADMIN)).rejects.toMatchObject({ code: "VALIDATION" })
    await expect(s.chooseAdapter({ mac: OTHER.mac, confirmed: false }, ADMIN)).rejects.toMatchObject({ code: "CONFIRMATION_REQUIRED" })
    expect(kernel.ran).toEqual([])
    expect((await db.prisma.equipmentNetwork.findUniqueOrThrow({ where: { id: "global" } })).adapterMac).toBeNull()
  })
})

describe("Red de equipos: the equipment IP", () => {
  it("without a profile default it is not set: no VLAN addresses, saving asks for it", async () => {
    const s = await start({ equipmentIp: null })
    expect(s.settings().equipmentIp).toBeNull()
    expect(s.editContext(null)).toMatchObject({ equipmentIp: null, equipmentPort: 22 })
    await expect(s.saveSettings({ ...s.settings(), equipmentIp: "", enabled: true, switchHost: "192.168.0.99" }, ADMIN)).rejects.toThrow(/IPv4/)
  })
})

describe("Red de equipos: the bench PC with another NIC on 192.168.1.0/24", () => {
  it("choose → only the chosen interface gets the management address → find the switch → prepare; the other NICs never change", async () => {
    const s = await start()
    await s.chooseAdapter({ mac: USB.mac, confirmed: false }, ADMIN)
    expect(kernel.ran).toEqual([
      `addr add 192.168.0.250/24 dev ${USB.ifname} noprefixroute`,
      `route replace 192.168.0.0/24 dev ${USB.ifname} table 20000`,
      "route replace unreachable default table 20000",
      "rule add from 192.168.0.250/32 lookup 20000 pref 1000",
    ])
    expect(s.status().mgmt).toMatchObject({ mode: "own", address: "192.168.0.250/24", subnet: "192.168.0.0/24", ifname: USB.ifname, ready: true })
    // Step 2: the sweep goes out only from the chosen interface's address.
    const d = await s.discover(null, ADMIN)
    expect(d).toMatchObject({ host: "192.168.0.99", model: "TL-SG108E", portCount: 8, loginOk: true, adapterIfname: USB.ifname })
    expect(probes.length).toBeGreaterThan(0)
    expect(probes.every((p) => p.source === "192.168.0.250")).toBe(true)
    expect((await db.prisma.equipmentNetwork.findUniqueOrThrow({ where: { id: "global" } })).switchHost).toBe("192.168.0.99")

    // Step 3.
    const r = await s.prepare({ uplinkConfirmed: false }, ADMIN)
    expect(r.started).toBe(true)
    expect(r.preview?.uplinkCheck).toMatchObject({ detected: 1, ok: true })
    // Saved with a warning (not an error): the equipment network is also on enp4s0.
    expect(r.warnings.join(" ")).toMatch(/192\.168\.1\.0\/24\) también está en enp4s0 \(192\.168\.1\.203\/24\)/)
    expect(r.warnings.join(" ")).toMatch(/arp_ignore/)
    await until(() => s.status().job?.state === "done")
    expect(sw.state().dot1q.pvids).toEqual([1, 102, 103, 104, 105, 106, 107, 108])
    const row = await db.prisma.equipmentNetwork.findUniqueOrThrow({ where: { id: "global" } })
    expect(row).toMatchObject({ enabled: true, adapterMac: USB.mac, switchHost: "192.168.0.99", switchUsername: "admin" })
    expect(row.switchPassword).toMatch(/^v1:/)
    expect(await db.prisma.cableLabel.findFirst({ where: { kind: "net-adapter", identity: USB.mac } })).toMatchObject({ name: "ETH-01" })
    expect(labelReloads).toBe(1)
    expect(kernel.state.links.map((l) => l.ifname)).toEqual(expect.arrayContaining(["rmv102", "rmv108"]))

    // Port 3's usual address (.203) is enp4s0's: the VLAN gets another one; the others keep theirs.
    expect(s.route(2)).toMatchObject({ configured: true, ready: true, vid: 102, localAddress: "192.168.1.202", equipmentIp: "192.168.1.10" })
    expect(s.route(3)).toMatchObject({ ready: true, vid: 103, localAddress: "192.168.1.209" })
    expect(s.route(1).problem).toMatch(/servidor \(subida\)/)
    // The kernel's lookup: from each VLAN address to 192.168.1.10 through its own VLAN; without it, enp4s0 (main table).
    expect(await kernel.routeGet("192.168.1.10", "192.168.1.202")).toEqual({ dev: "rmv102", table: "20102" })
    expect(await kernel.routeGet("192.168.1.10", "192.168.1.209")).toEqual({ dev: "rmv103", table: "20103" })
    expect(await kernel.routeGet("192.168.1.10", "192.168.1.203")).toEqual({ dev: OTHER.ifname, table: "main" })
    // Nothing of the lab NIC, the other NIC, the default route or the main table changed.
    untouched(LAB.ifname)
    untouched(OTHER.ifname)
    expect(kernel.state.routes.filter((x) => x.table === "main")).toEqual(KERNEL.routes)
    expect(kernel.ran.some((c) => c.includes(LAB.ifname) || c.includes(OTHER.ifname) || / main\b/.test(c))).toBe(false)
    expect(kernel.state.rules.filter((x) => x.priority !== 0 && x.priority < 32766).every((x) => x.priority >= 1000 && x.priority <= 5094)).toBe(true)
    // The warning stays visible (status and health).
    expect(s.status().warnings.join(" ")).toMatch(/enp4s0/)
    expect(s.health().find((h) => h.id === "equipnet.overlap")).toMatchObject({ level: "warn" })
    expect(s.status().host).toMatchObject({ state: "ok" })
    expect(audit.inputs.map((a) => a.action)).toEqual(expect.arrayContaining(["equipnet.update", "equipnet.discover", "equipnet.switch.apply", "equipnet.host", "cable.label.create"]))
    expect(JSON.stringify(audit.inputs)).not.toContain('"admin"}') // the password never goes to the audit
  }, 30_000)

  it("with arp_ignore=1 the overlap is only information", async () => {
    const s = await start({ arpIgnore: "1" })
    await s.chooseAdapter({ mac: USB.mac, confirmed: false }, ADMIN)
    const res = await s.saveSettings({ ...settingsOf(s), enabled: true, switchHost: "192.168.0.99", switchUsername: "admin", switchPassword: "admin" }, ADMIN)
    expect(res.warnings.join(" ")).toMatch(/enp4s0/)
    expect(res.warnings.join(" ")).not.toMatch(/arp_ignore/)
    expect(s.health().find((h) => h.id === "equipnet.overlap")).toMatchObject({ level: "info" })
  })

  it("an interface that already has an address in the switch network: reused, nothing added", async () => {
    kernel.state.addrs.push({ ifname: USB.ifname, local: "192.168.0.20", prefixlen: 24 })
    kernel.state.routes.push({ table: "main", dst: "192.168.0.0/24", dev: USB.ifname })
    const s = await start()
    expect(s.status().adapters.find((a) => a.ifname === USB.ifname)).toMatchObject({ selectable: "yes", mgmtReuse: "192.168.0.20/24" })
    await s.chooseAdapter({ mac: USB.mac, confirmed: false }, ADMIN)
    expect(kernel.ran).toEqual([])
    expect(s.status().mgmt).toMatchObject({ mode: "reuse", address: "192.168.0.20/24", ready: true })
    expect(await s.discover(null, ADMIN)).toMatchObject({ host: "192.168.0.99" })
    expect(probes.every((p) => p.source === "192.168.0.20")).toBe(true)
  })

  it("an address equal to the switch IP is a clear error (and a typed IP the server has)", async () => {
    const s = await start()
    await s.chooseAdapter({ mac: USB.mac, confirmed: false }, ADMIN)
    await expect(s.discover("192.168.1.203", ADMIN)).rejects.toMatchObject({ code: "VALIDATION", message: expect.stringMatching(/IP del switch \(192\.168\.1\.203\) la tiene este servidor en enp4s0/) })
    await s.discover(null, ADMIN)
    // The adapter "got" the switch's IP (as reported on the bench PC).
    kernel.state.addrs.push({ ifname: USB.ifname, local: "192.168.0.99", prefixlen: 24 })
    await s.reconcileNow(ADMIN)
    const h = s.status().host
    expect(h.state).toBe("blocked")
    expect(h.detail).toMatch(/IP del switch \(192\.168\.0\.99\) la tiene este servidor en enx08beac3882ce.*sudo ip addr del 192\.168\.0\.99\/24 dev enx08beac3882ce/)
    await expect(s.discover(null, ADMIN)).rejects.toMatchObject({ code: "VALIDATION" })
  })

  it("a rule of the system that sorts before the app's is caught by the route check (never used silently)", async () => {
    const s = await start()
    await s.chooseAdapter({ mac: USB.mac, confirmed: false }, ADMIN)
    await s.saveSettings({ ...settingsOf(s), enabled: true, switchHost: "192.168.0.99", switchUsername: "admin", switchPassword: "admin" }, ADMIN)
    expect(s.route(2).ready).toBe(true)
    kernel.state.rules.push({ priority: 500, src: "all", srclen: null, table: "main" })
    await s.reconcileNow(ADMIN)
    expect(s.route(2)).toMatchObject({ ready: false })
    expect(s.route(2).problem).toMatch(/saldría por enp4s0, no por rmv102.*ip rule/)
    expect(s.status().host.state).toBe("error")
  })
})

describe("Red de equipos: leftovers of older versions", () => {
  const OLD = { ifname: "enxold0", up: true, kind: null, vlanId: null, parent: null, mac: "02:00:00:00:00:09" }
  beforeEach(() => {
    kernel.state.links.push(OLD)
    kernel.state.addrs.push({ ifname: OLD.ifname, local: "192.168.0.250", prefixlen: 24 })
    kernel.state.rules.push({ priority: 20000, src: "192.168.0.250", srclen: null, table: "20000" })
    kernel.state.routes.push({ table: "20000", dst: "192.168.0.0/24", dev: OLD.ifname })
  })

  it("are shown, never removed on their own; «Quitar restos» removes exactly them", async () => {
    const before = JSON.stringify(kernel.state)
    const s = await start()
    await s.reconcileNow(ADMIN)
    expect(kernel.ran).toEqual([])
    expect(JSON.stringify(kernel.state)).toBe(before)
    const l = s.status().leftovers
    expect(l.items.join(" ")).toMatch(/192\.168\.0\.250\/24 en enxold0/)
    expect(l.commands).toEqual(expect.arrayContaining(["ip addr del 192.168.0.250/24 dev enxold0", "ip rule del pref 20000 from 192.168.0.250/32 lookup 20000"]))
    expect(s.health().find((h) => h.id === "equipnet.leftovers")).toMatchObject({ level: "warn" })
    expect(s.status().offerSetup).toBe(true)
    // Choosing another interface with the same management address is refused until they are gone.
    await expect(s.chooseAdapter({ mac: USB.mac, confirmed: false }, ADMIN)).rejects.toMatchObject({ message: expect.stringMatching(/192\.168\.0\.250 ya la tiene enxold0.*Quitar restos/) })
    await s.cleanupLeftovers(ADMIN)
    expect(kernel.state.addrs.some((a) => a.ifname === OLD.ifname)).toBe(false)
    expect(kernel.state.rules.some((r) => r.priority === 20000)).toBe(false)
    expect(kernel.state.routes.some((r) => r.table === "20000")).toBe(false)
    expect(s.status().leftovers.items).toEqual([])
    untouched(LAB.ifname)
    untouched(OTHER.ifname)
    await s.chooseAdapter({ mac: USB.mac, confirmed: false }, ADMIN)
    expect(s.status().mgmt).toMatchObject({ mode: "own", ready: true, ifname: USB.ifname })
  })
})

describe("Red de equipos: leftovers while an interface is in use", () => {
  it("only the app's addresses on OTHER interfaces are leftovers; «Quitar restos» removes them, the chosen one keeps its own", async () => {
    const OLD = { ifname: "enxold0", up: true, kind: null, vlanId: null, parent: null, mac: "02:00:00:00:00:09" }
    kernel.state.links.push(OLD)
    kernel.state.addrs.push({ ifname: OLD.ifname, local: "192.168.0.249", prefixlen: 24 })
    kernel.state.rules.push({ priority: 20000, src: "192.168.0.249", srclen: null, table: "20000" })
    const s = await start()
    await s.chooseAdapter({ mac: USB.mac, confirmed: false }, ADMIN)
    expect(kernel.ran.some((c) => c.includes(OLD.ifname) || c.includes("192.168.0.249"))).toBe(false)
    expect(s.status().leftovers).toEqual({
      items: ["192.168.0.249/24 en enxold0 (dirección de gestión de la red de equipos)"],
      commands: ["ip addr del 192.168.0.249/24 dev enxold0", "ip rule del pref 20000 from 192.168.0.249/32 lookup 20000"],
    })
    // Unplugged chosen adapter: still only the other interface's address is a leftover.
    kernel.unplug(USB.ifname)
    nics = [LAB, OTHER]
    await s.reconcileNow(ADMIN)
    expect(s.status().leftovers.items).toHaveLength(1)
    await s.cleanupLeftovers(ADMIN)
    expect(kernel.state.addrs.some((a) => a.ifname === OLD.ifname)).toBe(false)
    expect(kernel.state.rules.some((r) => r.src === "192.168.0.249")).toBe(false)
    expect(kernel.state.rules.some((r) => r.src === "192.168.0.250" && r.priority === 1000)).toBe(true)
    expect(s.status().leftovers.items).toEqual([])
  })
})

describe("Red de equipos: advanced flows", () => {
  async function configured(o: { cap?: boolean } = {}): Promise<EquipnetServices> {
    const s = await start(o)
    await s.chooseAdapter({ mac: USB.mac, confirmed: false }, ADMIN)
    await s.saveSettings({ ...settingsOf(s), enabled: true, switchHost: "192.168.0.99", switchUsername: "admin", switchPassword: "admin" }, ADMIN)
    return s
  }

  it("the wrong uplink is detected from the counters: nothing is applied", async () => {
    sw.setClientPort(3)
    const s = await start()
    await s.chooseAdapter({ mac: USB.mac, confirmed: false }, ADMIN)
    await s.discover(null, ADMIN)
    const r = await s.prepare({ uplinkConfirmed: true }, ADMIN)
    expect(r.started).toBe(false)
    expect(r.preview?.blocked).toMatch(/puerto 3 del switch, no al 1/)
    expect(sw.state().dot1q.enabled).toBe(false)
  }, 30_000)

  it("without CAP_NET_ADMIN nothing is changed and the missing commands are listed", async () => {
    const s = await configured({ cap: false })
    expect(kernel.ran).toEqual([])
    const h = s.status().host
    expect(h.state).toBe("no-permission")
    expect(h.detail).toMatch(/CAP_NET_ADMIN/)
    expect(h.pending).toEqual(expect.arrayContaining([`ip addr add 192.168.0.250/24 dev ${USB.ifname} noprefixroute`, `ip link add link ${USB.ifname} name rmv102 type vlan id 102`]))
    expect(s.route(2)).toMatchObject({ ready: false })
    // No source address yet: «Buscar» cannot sweep (it would leave by another interface); a typed IP is tried alone.
    await expect(s.discover(null, ADMIN)).rejects.toMatchObject({ message: expect.stringMatching(/aún no tiene dirección en la red de gestión/) })
    expect(await s.discover("192.168.0.99", ADMIN)).toMatchObject({ host: "192.168.0.99" })
    expect(probes).toEqual([{ host: "192.168.0.99", source: null }])
  })

  it("preview → apply needs the plan id; remove and restore round-trip", async () => {
    const s = await configured()
    const p = await s.preview("apply", ADMIN)
    expect(p.blocked).toBeNull()
    await expect(s.apply({ kind: "apply", planId: "0".repeat(32), uplinkConfirmed: false }, ADMIN)).rejects.toMatchObject({ code: "CONFLICT" })
    await s.apply({ kind: "apply", planId: p.planId, uplinkConfirmed: false }, ADMIN)
    await until(() => s.status().job?.state === "done")
    expect((await s.preview("apply", ADMIN)).nothingToDo).toBe(true)

    const rm = await s.preview("remove", ADMIN)
    expect(rm.changes[0]).toMatch(/Desactivar la VLAN 802\.1Q/)
    await s.apply({ kind: "remove", planId: rm.planId, uplinkConfirmed: false }, ADMIN)
    await until(() => s.status().job?.kind === "remove" && s.status().job?.state === "done")
    expect(sw.state().dot1q.enabled).toBe(false)

    const back = await s.preview("restore", ADMIN)
    await s.apply({ kind: "restore", planId: back.planId, uplinkConfirmed: false }, ADMIN)
    await until(() => s.status().job?.kind === "restore" && s.status().job?.state === "done")
    expect(sw.state().dot1q.pvids).toEqual([1, 102, 103, 104, 105, 106, 107, 108])
    expect(s.backupFile()).toMatch(/switch-.*\.cfg$/)
  }, 30_000)

  it("link state per port, drift and the port that was just plugged in", async () => {
    const s = await configured()
    await s.testSwitch(ADMIN)
    expect(s.status().ports.find((p) => p.port === 3)?.link).toBe("up")
    expect(s.editContext(null).suggestedPort).toBeNull()
    sw.setLink(5, true)
    await s.testSwitch(ADMIN)
    expect(s.editContext(null)).toMatchObject({ configured: true, suggestedPort: 5 })
    expect(s.route(5).link).toBe("up")
  })

  it("a failed step rolls the switch back to what it was", async () => {
    const s = await configured()
    const p = await s.preview("apply", ADMIN)
    sw.failNext("/vlanPvidSet.cgi", 1)
    await s.apply({ kind: "apply", planId: p.planId, uplinkConfirmed: false }, ADMIN)
    await until(() => s.status().job?.state === "failed")
    expect(s.status().job?.error).toMatch(/Se ha vuelto a la configuración que tenía el switch/)
    expect(sw.state().dot1q.enabled).toBe(false)
  }, 30_000)

  it("disabling removes the server VLANs; «Dejar de usar» removes everything of the app from the interface", async () => {
    const s = await configured()
    expect(kernel.state.links.some((l) => l.ifname === "rmv104")).toBe(true)
    await s.saveSettings({ ...settingsOf(s), enabled: false }, ADMIN)
    expect(kernel.state.links.some((l) => l.ifname.startsWith("rmv"))).toBe(false)
    expect(kernel.state.addrs.some((a) => a.ifname === USB.ifname && a.local === "192.168.0.250")).toBe(true)
    // The equipment IP must not be an address of the server itself.
    await expect(s.saveSettings({ ...settingsOf(s), enabled: true, equipmentIp: "172.20.5.50", equipmentPrefix: 16 }, ADMIN)).rejects.toMatchObject({ code: "VALIDATION", message: expect.stringMatching(/tiene la IP de los equipos \(172\.20\.5\.50\) en enp3s0/) })
    await s.chooseAdapter({ mac: null, confirmed: false }, ADMIN)
    expect(JSON.stringify(kernel.state)).toBe(JSON.stringify(KERNEL))
    expect(s.status().host.state).toBe("off")
  })

  it("adapter unplugged and plugged again: the VLANs come back", async () => {
    const s = await configured()
    kernel.unplug(USB.ifname)
    nics = [LAB, OTHER]
    await s.reconcileNow(ADMIN)
    expect(s.status().host.state).toBe("no-adapter")
    expect(s.route(2).ready).toBe(false)
    kernel.state.links.push(link(USB))
    nics = [USB, LAB, OTHER]
    await s.reconcileNow(ADMIN)
    expect(s.route(2).ready).toBe(true)
  })
})
