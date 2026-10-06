// Host side of "Red de equipos" (pure): from the desired state (the adapter the admin chose, the management address
// and one VLAN interface per equipment port) and the current state (`ip -json …`), the `ip` commands that make it so,
// and which VLANs are usable right now. Only touches what belongs to the app:
//   - links named rmv<vid> (VLAN interfaces on the chosen adapter),
//   - rules whose table is one of the app's (20000..24094) and whose preference is the app's (1000..5094, or the
//     20000..24094 of older versions),
//   - routes in tables 20000..24094,
//   - addresses on rmv* links, and on the chosen adapter only the management address (marked by its table-20000 rule).
// A management address of the app left on ANOTHER interface (older versions put one on any free USB adapter) is never
// removed here unless the admin asked for it (`cleanup`): it is reported as a leftover instead.
// Never the main table, never another interface. validateIpCommand() enforces it again right before running anything.
import { inSubnet, parseCidr } from "@/lib/equipnet/ipv4"
import {
  LEGACY_PREF_MAX, LEGACY_PREF_MIN, MGMT_TABLE, PREF_BASE, PREF_MAX, prefOfTable, TABLE_MAX, VLAN_IF_RE, type MgmtPlan, type PortPlan,
} from "@/lib/equipnet/plan"

export interface LinkInfo { ifname: string; up: boolean; kind: string | null; vlanId: number | null; parent: string | null; mac: string | null }
export interface AddrInfo { ifname: string; local: string; prefixlen: number }
export interface RuleInfo { priority: number; src: string | null; srclen: number | null; table: string | null }
/** `type` null = a normal (unicast) route; "unreachable", "blackhole"… otherwise. */
export interface RouteInfo { table: string; dst: string; dev: string | null; type?: string | null }
export interface HostState { links: LinkInfo[]; addrs: AddrInfo[]; rules: RuleInfo[]; routes: RouteInfo[] }

export interface HostDesired {
  /** The adapter the admin chose (wired to the switch); null = nothing of the app (teardown, only on request). */
  parent: string | null
  /** Our own management address; null = none (the adapter already has one in the switch network, or no switch). */
  mgmt: MgmtPlan | null
  vlans: PortPlan[]
  /** Equipment subnet ("192.168.1.0/24") and prefix. */
  subnet: string
  prefix: number
  /** Other interfaces whose leftover management address of the app may be removed (explicit admin request only). */
  cleanup?: readonly string[]
}

export type IpCommand = string[]
export interface Leftover { ifname: string; address: string; prefixlen: number }
export interface HostPlan {
  commands: IpCommand[]
  /** Per VLAN id: interface, address, rule and routes in place now (before running the commands). */
  ready: Record<number, boolean>
  mgmtReady: boolean
  /** Management addresses of the app on interfaces this plan may not touch (left by older versions). */
  leftovers: Leftover[]
}

const inRange = (n: number, a: number, b: number) => Number.isInteger(n) && n >= a && n <= b
export const ownedTable = (t: string | null | undefined): boolean => inRange(Number(t), MGMT_TABLE, TABLE_MAX)
export const ownedPref = (p: number): boolean => inRange(p, PREF_BASE, PREF_MAX) || inRange(p, LEGACY_PREF_MIN, LEGACY_PREF_MAX)
export const ownedRule = (r: RuleInfo): boolean => ownedPref(r.priority) && ownedTable(r.table)
const isOurLink = (l: LinkInfo): boolean => VLAN_IF_RE.test(l.ifname)
const hostRoute = (r: RuleInfo): boolean => r.srclen === null || r.srclen === 32
const typeOf = (r: RouteInfo): string => r.type ?? "unicast"
const DROP_TYPES = new Set(["unreachable", "blackhole", "prohibit", "throw"])

interface WantRoute { table: string; dst: string; dev: string | null; type: "unicast" | "unreachable" }

/** The management addresses of the app: sources of its rules on table 20000. */
export function markedMgmtAddresses(current: HostState): string[] {
  return current.rules.filter((r) => ownedRule(r) && r.table === String(MGMT_TABLE) && r.src && r.src !== "all" && hostRoute(r)).map((r) => r.src ?? "")
}

export function planHost(desired: HostDesired, current: HostState): HostPlan {
  const cmds: IpCommand[] = []
  const P = desired.parent
  const cleanup = new Set(desired.cleanup ?? [])
  const link = (n: string) => current.links.find((l) => l.ifname === n)
  const addrsOf = (n: string) => current.addrs.filter((a) => a.ifname === n)
  const rules = current.rules.filter(ownedRule)
  const routes = current.routes.filter((r) => ownedTable(r.table))
  const wanted = P ? desired.vlans : []
  const wantedNames = new Set(wanted.map((v) => v.ifname))
  const mgmt = P ? desired.mgmt : null

  // Management addresses of the app (marked by their rule): kept on the parent when wanted, removed from the parent
  // or from an interface the admin asked to clean, otherwise left alone and reported.
  const marked = markedMgmtAddresses(current)
  const leftovers: Leftover[] = []
  const mgmtDeletes: IpCommand[] = []
  for (const a of current.addrs) {
    if (!marked.includes(a.local) || VLAN_IF_RE.test(a.ifname)) continue
    if (mgmt && a.local === mgmt.address && a.ifname === P && a.prefixlen === mgmt.prefix) continue
    if (a.ifname === P || cleanup.has(a.ifname)) mgmtDeletes.push(["addr", "del", `${a.local}/${a.prefixlen}`, "dev", a.ifname])
    else leftovers.push({ ifname: a.ifname, address: a.local, prefixlen: a.prefixlen })
  }
  const leftoverAddrs = new Set(leftovers.map((l) => l.address))

  // 1. The adapter up.
  const parent = P ? link(P) : undefined
  if (P && parent && !parent.up) cmds.push(["link", "set", "dev", P, "up"])

  // 2. Links: remove foreign/obsolete rmv*, create the missing ones.
  const goodLink = (v: PortPlan) => {
    const l = link(v.ifname)
    return !!l && l.kind === "vlan" && l.vlanId === v.vid && l.parent === P
  }
  for (const l of current.links.filter(isOurLink)) {
    const v = wanted.find((x) => x.ifname === l.ifname)
    if (!wantedNames.has(l.ifname) || !v || !goodLink(v)) cmds.push(["link", "del", "dev", l.ifname])
  }
  if (P) {
    for (const v of wanted) {
      if (!goodLink(v)) {
        // addrgenmode inside "link add" is rejected by the kernel (EAFNOSUPPORT): set it on the new, still-down link.
        cmds.push(["link", "add", "link", P, "name", v.ifname, "type", "vlan", "id", String(v.vid)])
        cmds.push(["link", "set", "dev", v.ifname, "addrgenmode", "none"])
        cmds.push(["link", "set", "dev", v.ifname, "up"])
      } else if (!link(v.ifname)?.up) cmds.push(["link", "set", "dev", v.ifname, "up"])
    }
  }

  // Routes of our tables: each table has its network route and an "unreachable default", so a lookup in it never
  // falls through to the main table (a missing route fails closed instead of leaving by another interface).
  const want: WantRoute[] = []
  if (mgmt && P) {
    want.push({ table: String(mgmt.table), dst: mgmt.subnet, dev: P, type: "unicast" })
    want.push({ table: String(mgmt.table), dst: "default", dev: null, type: "unreachable" })
  }
  if (P) {
    for (const v of wanted) {
      want.push({ table: String(v.table), dst: desired.subnet, dev: v.ifname, type: "unicast" })
      want.push({ table: String(v.table), dst: "default", dev: null, type: "unreachable" })
    }
  }
  const same = (r: RouteInfo, w: WantRoute) => r.table === w.table && r.dst === w.dst && typeOf(r) === w.type && (w.type !== "unicast" || r.dev === w.dev)
  // Before any address change (deleting the last address of a device makes the kernel drop its routes, and a later
  // "route del" would then fail).
  for (const r of routes) {
    if (want.some((w) => same(r, w))) continue
    // Routes of a link that is going to be deleted and recreated vanish with it.
    const linkGoes = r.dev !== null && VLAN_IF_RE.test(r.dev) && cmds.some((c) => c[0] === "link" && c[1] === "del" && c[3] === r.dev)
    if (linkGoes) continue
    const t = typeOf(r)
    if (t === "unicast") cmds.push(["route", "del", r.dst, "table", r.table])
    else if (DROP_TYPES.has(t)) cmds.push(["route", "del", t, r.dst, "table", r.table])
  }

  // 3. Addresses on the VLAN interfaces (only the planned one each).
  for (const v of wanted) {
    const fresh = !goodLink(v)
    const have = fresh ? [] : addrsOf(v.ifname)
    if (P && !have.some((a) => a.local === v.hostAddress && a.prefixlen === desired.prefix)) {
      cmds.push(["addr", "add", `${v.hostAddress}/${desired.prefix}`, "dev", v.ifname, "noprefixroute"])
    }
    for (const a of have) if (a.local !== v.hostAddress || a.prefixlen !== desired.prefix) cmds.push(["addr", "del", `${a.local}/${a.prefixlen}`, "dev", v.ifname])
  }

  // 4. The management address on the adapter.
  cmds.push(...mgmtDeletes)
  if (mgmt && P && !current.addrs.some((a) => a.ifname === P && a.local === mgmt.address && a.prefixlen === mgmt.prefix)) {
    cmds.push(["addr", "add", `${mgmt.address}/${mgmt.prefix}`, "dev", P, "noprefixroute"])
  }

  // 5. Routes of our tables (again after any address change on their device, which may have dropped them).
  for (const w of want) {
    if (w.type === "unreachable") {
      if (!routes.some((r) => same(r, w))) cmds.push(["route", "replace", "unreachable", "default", "table", w.table])
      continue
    }
    const dev = w.dev ?? ""
    const keep = routes.some((r) => same(r, w))
    const recreated = VLAN_IF_RE.test(dev) && cmds.some((c) => c[0] === "link" && c[1] === "add" && c[5] === dev)
    const addrChanged = cmds.some((c) => c[0] === "addr" && c[4] === dev)
    if (!keep || recreated || addrChanged) cmds.push(["route", "replace", w.dst, "dev", dev, "table", w.table])
  }

  // 6. Rules: "from <address> lookup <table> pref 1000 + (table - 20000)", one per address.
  const wantRules: Array<{ pref: number; addr: string; table: number }> = []
  if (mgmt) wantRules.push({ pref: prefOfTable(mgmt.table), addr: mgmt.address, table: mgmt.table })
  if (P) for (const v of wanted) wantRules.push({ pref: prefOfTable(v.table), addr: v.hostAddress, table: v.table })
  const isWanted = (r: RuleInfo) => wantRules.some((w) => r.priority === w.pref && r.src === w.addr && hostRoute(r) && r.table === String(w.table))
  for (const r of rules) {
    if (isWanted(r)) continue
    // The rule that marks a leftover management address stays with it (so it can still be recognised and removed).
    if (r.table === String(MGMT_TABLE) && r.src && leftoverAddrs.has(r.src)) continue
    cmds.push(["rule", "del", "pref", String(r.priority), ...(r.src && r.src !== "all" ? ["from", `${r.src}/${r.srclen ?? 32}`] : []), "lookup", r.table ?? ""])
  }
  for (const w of wantRules) {
    if (!rules.some((r) => r.priority === w.pref && r.src === w.addr && hostRoute(r) && r.table === String(w.table))) {
      cmds.push(["rule", "add", "from", `${w.addr}/32`, "lookup", String(w.table), "pref", String(w.pref)])
    }
  }

  // Readiness now.
  const hasRoutes = (table: number, dst: string, dev: string) => routes.some((r) => r.table === String(table) && r.dst === dst && r.dev === dev && typeOf(r) === "unicast")
    && routes.some((r) => r.table === String(table) && r.dst === "default" && typeOf(r) === "unreachable")
  const ready: Record<number, boolean> = {}
  for (const v of desired.vlans) {
    ready[v.vid] = !!P && goodLink(v) && !!link(v.ifname)?.up
      && addrsOf(v.ifname).some((a) => a.local === v.hostAddress)
      && rules.some((r) => r.priority === v.pref && r.src === v.hostAddress && r.table === String(v.table))
      && hasRoutes(v.table, desired.subnet, v.ifname)
  }
  const mgmtReady = !!mgmt && !!P && current.addrs.some((a) => a.ifname === P && a.local === mgmt.address)
    && rules.some((r) => r.priority === prefOfTable(mgmt.table) && r.src === mgmt.address && r.table === String(mgmt.table))
    && hasRoutes(mgmt.table, mgmt.subnet, P)
  return { commands: cmds, ready, mgmtReady, leftovers }
}

export interface IpGuard {
  /** The chosen adapter (null: only removals of what is ours). */
  parent: string | null
  /** Interfaces no command may name: the default route's and every interface the admin did not choose. */
  forbidden: readonly string[]
  /** Interfaces whose leftover management address may be deleted (explicit admin request). */
  cleanup?: readonly string[]
}

/**
 * The last guard before running `ip`: only the command shapes above, only on rmv<vid> links or the chosen adapter,
 * only our tables and preferences, never the main table, never a forbidden interface. Returns why a command is
 * refused, or null.
 */
export function validateIpCommand(cmd: readonly string[], o: IpGuard): string | null {
  const ourLink = (n: string | undefined) => !!n && VLAN_IF_RE.test(n) && Number(VLAN_IF_RE.exec(n)?.[1]) >= 2 && Number(VLAN_IF_RE.exec(n)?.[1]) <= 4094
  // Never something `ip` could read as an option, whatever the source of the name.
  const safeName = (n: string | undefined) => !!n && /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,14}$/.test(n)
  const isParent = (n: string | undefined) => safeName(n) && !!o.parent && n === o.parent
  const table = (t: string | undefined) => ownedTable(t ?? null)
  const cidr = (c: string | undefined) => !!c && parseCidr(c) !== null
  for (const f of o.forbidden) if (f && cmd.includes(f)) return `la orden toca ${f}, que no es la interfaz elegida para la red de equipos`
  const s = cmd.join(" ")
  const [obj, verb] = cmd
  if (obj === "link") {
    if (verb === "set" && cmd.length === 5 && cmd[2] === "dev" && cmd[4] === "up" && (ourLink(cmd[3]) || isParent(cmd[3]))) return null
    if (verb === "set" && cmd.length === 6 && cmd[2] === "dev" && ourLink(cmd[3]) && cmd[4] === "addrgenmode" && cmd[5] === "none") return null
    if (verb === "del" && cmd.length === 4 && cmd[2] === "dev" && ourLink(cmd[3])) return null
    if (verb === "add" && cmd.length === 10 && cmd[2] === "link" && isParent(cmd[3]) && cmd[4] === "name" && ourLink(cmd[5])
      && cmd[6] === "type" && cmd[7] === "vlan" && cmd[8] === "id" && `rmv${cmd[9]}` === cmd[5]) return null
  } else if (obj === "addr") {
    const dev = cmd[4]
    const cleanable = verb === "del" && safeName(dev) && !!dev && (o.cleanup ?? []).includes(dev)
    const onOurs = ourLink(dev) || isParent(dev) || cleanable
    if (verb === "add" && cmd.length === 6 && cidr(cmd[2]) && cmd[3] === "dev" && onOurs && cmd[5] === "noprefixroute") return null
    if (verb === "del" && cmd.length === 5 && cidr(cmd[2]) && cmd[3] === "dev" && onOurs) return null
  } else if (obj === "route") {
    if (verb === "replace" && cmd.length === 7 && cidr(cmd[2]) && cmd[3] === "dev" && (ourLink(cmd[4]) || isParent(cmd[4])) && cmd[5] === "table" && table(cmd[6])) return null
    if (verb === "replace" && cmd.length === 6 && cmd[2] === "unreachable" && cmd[3] === "default" && cmd[4] === "table" && table(cmd[5])) return null
    if (verb === "del" && cmd.length === 5 && (cidr(cmd[2]) || cmd[2] === "default") && cmd[3] === "table" && table(cmd[4])) return null
    if (verb === "del" && cmd.length === 6 && DROP_TYPES.has(cmd[2] ?? "") && (cidr(cmd[3]) || cmd[3] === "default") && cmd[4] === "table" && table(cmd[5])) return null
  } else if (obj === "rule") {
    if (verb === "add" && cmd.length === 8 && cmd[2] === "from" && /\/32$/.test(cmd[3] ?? "") && cidr(cmd[3]) && cmd[4] === "lookup" && table(cmd[5])
      && cmd[6] === "pref" && cmd[7] === String(prefOfTable(Number(cmd[5])))) return null
    if (verb === "del" && cmd[2] === "pref" && ownedPref(Number(cmd[3])) && cmd.at(-2) === "lookup" && table(cmd.at(-1))
      && (cmd.length === 6 || (cmd.length === 8 && cmd[4] === "from" && cidr(cmd[5])))) return null
  }
  return `orden no permitida: ip ${s}`
}

/** Is this address inside the equipment subnet (for the forwarder's source checks)? */
export const inEquipmentSubnet = inSubnet
