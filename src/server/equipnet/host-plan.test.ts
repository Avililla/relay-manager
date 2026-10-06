import { describe, expect, it } from "vitest"
import { DEFAULT_EQUIPNET, planEquipnet } from "@/lib/equipnet/plan"
import { planHost, validateIpCommand, type HostDesired, type HostState } from "./host-plan"
import { FakeKernel } from "./testing/fake-kernel"

const plan = planEquipnet(DEFAULT_EQUIPNET)
const P = "enx08beac3882ce"
const desired: HostDesired = { parent: P, mgmt: plan.mgmt, vlans: plan.ports, subnet: plan.subnet, prefix: plan.prefix }
const lab = { ifname: "enp3s0", up: true, kind: null, vlanId: null, parent: null, mac: "2c:58:b9:d1:c6:57" }
const empty: HostState = {
  links: [lab, { ifname: P, up: true, kind: null, vlanId: null, parent: null, mac: "08:be:ac:38:82:ce" }],
  addrs: [{ ifname: "enp3s0", local: "198.51.100.118", prefixlen: 24 }],
  rules: [{ priority: 0, src: "all", srclen: null, table: "local" }, { priority: 32766, src: "all", srclen: null, table: "main" }],
  routes: [{ table: "main", dst: "default", dev: "enp3s0" }, { table: "main", dst: "198.51.100.0/24", dev: "enp3s0" }],
}

/** Applies the planned commands to a model of the kernel state (the fake kernel of the service tests, unvalidated). */
function applyCmds(st: HostState, cmds: string[][]): HostState {
  return new FakeKernel(st).force(cmds)
}

describe("planHost", () => {
  it("from nothing: VLAN interfaces, addresses with noprefixroute, own tables (route + unreachable default), one rule per address", () => {
    const p = planHost(desired, empty)
    const txt = p.commands.map((c) => c.join(" "))
    expect(txt).toContain(`link add link ${P} name rmv102 type vlan id 102`)
    expect(txt).toContain("link set dev rmv102 addrgenmode none")
    expect(txt).toContain("link set dev rmv102 up")
    expect(txt).toContain("addr add 192.168.1.202/24 dev rmv102 noprefixroute")
    expect(txt).toContain(`addr add 192.168.0.250/24 dev ${P} noprefixroute`)
    expect(txt).toContain("route replace 192.168.1.0/24 dev rmv108 table 20108")
    expect(txt).toContain("route replace unreachable default table 20108")
    expect(txt).toContain(`route replace 192.168.0.0/24 dev ${P} table 20000`)
    expect(txt).toContain("route replace unreachable default table 20000")
    // Preferences 1000 + (table - 20000): before the main table (32766) and before Tailscale's 52xx.
    expect(txt).toContain("rule add from 192.168.1.203/32 lookup 20103 pref 1103")
    expect(txt).toContain("rule add from 192.168.0.250/32 lookup 20000 pref 1000")
    expect(p.ready[102]).toBe(false)
    expect(p.mgmtReady).toBe(false)
    expect(p.leftovers).toEqual([])
    // Never the main table, the lab NIC or a default route outside our tables.
    expect(txt.some((t) => /enp3s0|table main|via/.test(t))).toBe(false)
    for (const c of p.commands) expect(validateIpCommand(c, { parent: P, forbidden: ["enp3s0"] })).toBeNull()
  })
  it("converges: once applied there is nothing left to do and every VLAN is ready", () => {
    const after = applyCmds(empty, planHost(desired, empty).commands)
    const again = planHost(desired, after)
    expect(again.commands).toEqual([])
    expect(Object.values(again.ready).every(Boolean)).toBe(true)
    expect(again.mgmtReady).toBe(true)
    expect(after.routes.filter((r) => r.table === "main")).toEqual(empty.routes)
  })
  it("fails closed: without its network route a table answers «unreachable», never falls through to the main table", async () => {
    const other: HostState = {
      ...empty,
      addrs: [...empty.addrs, { ifname: "enp4s0", local: "192.168.1.50", prefixlen: 24 }],
      routes: [...empty.routes, { table: "main", dst: "192.168.1.0/24", dev: "enp4s0" }],
    }
    const k = new FakeKernel(other)
    k.force(planHost(desired, other).commands)
    expect(await k.routeGet("192.168.1.10", "192.168.1.202")).toEqual({ dev: "rmv102", table: "20102" })
    // Main-table traffic (no source of ours) still goes to the other network.
    expect(await k.routeGet("192.168.1.10", "192.168.1.50")).toEqual({ dev: "enp4s0", table: "main" })
    k.state.routes = k.state.routes.filter((r) => !(r.table === "20102" && r.dst === "192.168.1.0/24"))
    expect(await k.routeGet("192.168.1.10", "192.168.1.202")).toBeNull()
  })
  it("moves the rules of older versions (pref = table) to the new preferences", () => {
    const ok = applyCmds(empty, planHost(desired, empty).commands)
    const legacy: HostState = { ...ok, rules: ok.rules.map((r) => (r.table && Number(r.table) >= 20000 ? { ...r, priority: Number(r.table) } : r)) }
    const txt = planHost(desired, legacy).commands.map((c) => c.join(" "))
    expect(txt).toContain("rule del pref 20102 from 192.168.1.202/32 lookup 20102")
    expect(txt).toContain("rule add from 192.168.1.202/32 lookup 20102 pref 1102")
    expect(txt).toContain("rule del pref 20000 from 192.168.0.250/32 lookup 20000")
  })
  it("repairs drift: a missing route, a foreign address on rmv103, a stray rmv999 and a moved management address", () => {
    const ok = applyCmds(empty, planHost(desired, empty).commands)
    const broken: HostState = {
      ...ok,
      routes: ok.routes.filter((r) => !(r.table === "20104" && !r.type)),
      addrs: [...ok.addrs, { ifname: "rmv103", local: "10.0.0.1", prefixlen: 8 }],
      links: [...ok.links, { ifname: "rmv999", up: true, kind: "vlan", vlanId: 999, parent: P, mac: null }],
    }
    const txt = planHost(desired, broken).commands.map((c) => c.join(" "))
    expect(txt).toEqual(expect.arrayContaining(["link del dev rmv999", "addr del 10.0.0.1/8 dev rmv103", "route replace 192.168.1.0/24 dev rmv104 table 20104"]))
    const movedPlan = planHost({ ...desired, mgmt: desired.mgmt ? { ...desired.mgmt, address: "192.168.0.251" } : null }, ok)
    const moved = movedPlan.commands.map((c) => c.join(" "))
    // The kernel drops the table 20000 route with the last address of the adapter: it is added again afterwards.
    const afterMove = applyCmds(ok, movedPlan.commands)
    expect(afterMove.routes).toContainEqual({ table: "20000", dst: "192.168.0.0/24", dev: P, type: null })
    expect(moved).toEqual(expect.arrayContaining([`addr del 192.168.0.250/24 dev ${P}`, `addr add 192.168.0.251/24 dev ${P} noprefixroute`, "rule del pref 1000 from 192.168.0.250/32 lookup 20000"]))
  })
  it("a management address of the app on ANOTHER interface (older versions) is a leftover: untouched unless asked", () => {
    const ok = applyCmds(empty, planHost(desired, empty).commands)
    const old: HostState = {
      ...ok,
      links: [...ok.links, { ifname: "enxold", up: true, kind: null, vlanId: null, parent: null, mac: "02:00:00:00:00:09" }],
      addrs: [...ok.addrs, { ifname: "enxold", local: "192.168.0.249", prefixlen: 24 }],
      rules: [...ok.rules, { priority: 20000, src: "192.168.0.249", srclen: null, table: "20000" }],
    }
    const p = planHost(desired, old)
    expect(p.commands).toEqual([])
    expect(p.leftovers).toEqual([{ ifname: "enxold", address: "192.168.0.249", prefixlen: 24 }])
    // On request (cleanup) it goes, with its rule; the chosen interface keeps everything.
    const c = planHost({ ...desired, cleanup: ["enxold"] }, old)
    expect(c.commands.map((x) => x.join(" "))).toEqual(["addr del 192.168.0.249/24 dev enxold", "rule del pref 20000 from 192.168.0.249/32 lookup 20000"])
    for (const x of c.commands) expect(validateIpCommand(x, { parent: P, forbidden: ["enp3s0"], cleanup: ["enxold"] })).toBeNull()
    // Without the request, the guard refuses it.
    expect(validateIpCommand(["addr", "del", "192.168.0.249/24", "dev", "enxold"], { parent: P, forbidden: ["enp3s0", "enxold"] })).not.toBeNull()
  })
  it("teardown: removes only what is the app's", () => {
    const ok = applyCmds(empty, planHost(desired, empty).commands)
    const foreignRule = { priority: 5270, src: "all", srclen: null, table: "52" }
    const p = planHost({ ...desired, parent: null, mgmt: null, vlans: [], cleanup: [P] }, { ...ok, rules: [...ok.rules, foreignRule] })
    const txt = p.commands.map((c) => c.join(" "))
    // Route deletions come before the address deletions (the kernel would drop the routes first).
    expect(txt.indexOf("route del 192.168.0.0/24 table 20000")).toBeLessThan(txt.indexOf(`addr del 192.168.0.250/24 dev ${P}`))
    expect(txt).toContain("route del unreachable default table 20000")
    expect(txt.filter((t) => t.startsWith("link del"))).toHaveLength(7)
    expect(txt).toContain(`addr del 192.168.0.250/24 dev ${P}`)
    expect(txt.filter((t) => t.startsWith("rule del"))).toHaveLength(8)
    expect(txt.some((t) => t.includes("5270") || t.includes("enp3s0"))).toBe(false)
    const after = applyCmds({ ...ok, rules: [...ok.rules, foreignRule] }, p.commands)
    expect(after.rules).toContainEqual(foreignRule)
    expect(after.routes.filter((r) => Number(r.table) >= 20000)).toEqual([])
    expect(after.links.map((l) => l.ifname).sort()).toEqual(["enp3s0", P].sort())
    for (const c of p.commands) expect(validateIpCommand(c, { parent: null, forbidden: ["enp3s0"], cleanup: [P] })).toBeNull()
  })
})

describe("validateIpCommand", () => {
  const o = { parent: P, forbidden: ["enp3s0", "enp4s0"] }
  it("refuses anything outside the app's links, tables and preferences, and any interface not chosen", () => {
    for (const bad of [
      ["route", "replace", "default", "via", "192.168.1.1"],
      ["route", "replace", "192.168.1.0/24", "dev", "rmv102", "table", "main"],
      ["route", "replace", "unreachable", "default", "table", "main"],
      ["route", "del", "198.51.100.0/24", "table", "254"],
      ["route", "del", "default", "table", "main"],
      ["addr", "add", "192.168.1.202/24", "dev", "enp3s0", "noprefixroute"],
      ["addr", "add", "192.168.1.202/24", "dev", "eth9", "noprefixroute"],
      ["addr", "del", "192.168.1.50/24", "dev", "enp4s0"],
      ["link", "del", "dev", "enx08beac3882ce"],
      ["link", "set", "dev", "enp3s0", "up"],
      ["link", "add", "link", "enp3s0", "name", "rmv102", "type", "vlan", "id", "102"],
      ["link", "add", "link", "enp4s0", "name", "rmv102", "type", "vlan", "id", "102"],
      ["link", "add", "link", P, "name", "rmv102", "type", "vlan", "id", "103"],
      ["link", "set", "dev", "enp3s0", "addrgenmode", "none"],
      ["rule", "add", "from", "192.168.1.0/24", "lookup", "20102", "pref", "1102"],
      ["rule", "add", "from", "192.168.1.202/32", "lookup", "main", "pref", "100"],
      // The preference must be the table's (1000 + vid): never another one, never the old 20000+ range for new rules.
      ["rule", "add", "from", "192.168.1.202/32", "lookup", "20102", "pref", "20102"],
      ["rule", "add", "from", "192.168.1.202/32", "lookup", "20102", "pref", "100"],
      ["rule", "del", "pref", "32766", "lookup", "main"],
      ["rule", "del", "pref", "5270", "lookup", "52"],
      ["addr", "flush", "dev", "rmv102"],
    ]) expect(validateIpCommand(bad, o), bad.join(" ")).not.toBeNull()
    // A name that `ip` would read as an option is refused even when it is the configured adapter.
    expect(validateIpCommand(["link", "set", "dev", "-all", "up"], { parent: "-all", forbidden: [] })).not.toBeNull()
    // The app's own shapes pass.
    for (const good of [
      ["rule", "add", "from", "192.168.1.202/32", "lookup", "20102", "pref", "1102"],
      ["rule", "del", "pref", "20102", "from", "192.168.1.202/32", "lookup", "20102"],
      ["route", "replace", "unreachable", "default", "table", "20102"],
      ["route", "del", "unreachable", "default", "table", "20102"],
    ]) expect(validateIpCommand(good, o), good.join(" ")).toBeNull()
  })
})
