// "Red de equipos" service (Graph A, rt.equipnet). Every equipment has the same IP on its Ethernet and is plugged into
// its own port of a small managed switch; each port is its own 802.1Q VLAN, trunked (tagged) to the port wired to a
// network interface of this server that the admin chooses. This service:
//   - lists every network interface (sysfs + `ip`) and lets the admin choose the one wired to the switch; until then
//     it never changes anything in the server's network (older versions' leftovers are only reported);
//   - on the chosen interface only, keeps the server side in place: the management address (unless the interface
//     already has one in the switch network), and when enabled one VLAN interface rmv<vid> per equipment port with its
//     own address and policy routing (host-plan.ts + iproute.ts; reconciled on start, on every change and every 15 s,
//     verified with `ip route get`); never the main table, never another interface, never the default route;
//   - finds the switch only through the chosen interface (or at the IP the admin typed), talks to it (drivers/): link
//     state per port, drift, and the audited, previewed, lockout-safe setup (switch-runner.ts) with a backup and
//     "Restaurar configuración anterior";
//   - tells the access service how to reach each port (route()).
import crypto from "node:crypto"
import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import { z } from "zod"
import {
  EquipnetSettingsInputSchema, SwitchDriverSchema, type EquipnetSettingsDTO, type EquipnetSettingsInput,
  type EquipnetStatusDTO, type HostNetStatusDTO, type LinkState, type ManualInstructionsDTO, type MgmtStatusDTO, type NetAdapterDTO,
  type OtherIfaceDTO, type SwitchDetectionDTO, type SwitchJobDTO, type SwitchJobKind, type SwitchPortDTO, type SwitchPortPlanDTO,
  type SwitchPortUseDTO, type SwitchPreviewDTO, type SwitchStatusDTO,
} from "@/lib/contracts/equipnet"
import type { HealthCheckDTO } from "@/lib/contracts/system"
import type { JsonValue } from "@/lib/contracts/common"
import type { AuditAction } from "@/lib/contracts/audit"
import { formatIPv4, inSubnet, overlaps, parseCidr, parseIPv4, subnetOf } from "@/lib/equipnet/ipv4"
import { planEquipnet, VLAN_IF_RE, type EquipnetPlan, type MgmtPlan } from "@/lib/equipnet/plan"
import {
  keepsManagement, layoutDrift, planSwitchOps, portList, portMembership, range, targetLayout, type Dot1qState, type SwitchOp,
} from "@/lib/equipnet/switch-layout"
import { nextCableName } from "@/lib/accesses/labels"
import {
  adapterProblem, describeSwitchOp, driftText, equipnetErrors, equipnetLog, hostDetail, JOB_KIND_LABEL, netWarning, switchDetail, switchJob,
} from "@/lib/i18n/equipnet"
import { DomainError } from "@/server/errors"
import type { Logger } from "@/server/log"
import type { ActorRef, EquipnetRoute, EquipnetServices, ServiceDeps } from "@/server/runtime/types"
import { SYSTEM_ACTOR } from "@/server/runtime/types"
import { switchDrivers } from "./drivers"
import { SwitchError, type SwitchDriver, type SwitchSession } from "./drivers/types"
import { markedMgmtAddresses, ownedRule, ownedTable, planHost, type AddrInfo, type HostDesired, type HostState, type IpCommand, type IpGuard, type Leftover } from "./host-plan"
import type { HttpFn } from "./http-client"
import { commandText, defaultRouteInterfaces, findIpBinary, hasNetAdmin, IpError, readHostState, routeGet as routeGetIp, runIpCommands } from "./iproute"
import { readNmDevices, type NmDevice } from "./nm"
import { openSecret, sealSecret } from "./secret"
import { detectServerPort, rollback, runSwitchOps, SwitchStepError } from "./switch-runner"
import { scanNetInterfaces, type NetIface } from "./sysfs"

/** Test seams. */
export interface EquipnetInternals {
  scanNet?: () => Promise<NetIface[]>
  readHost?: () => Promise<HostState>
  runIp?: (cmds: readonly IpCommand[], guard: IpGuard) => Promise<void>
  /** `ip route get <dst> from <from>`: the interface and table the kernel would use, or null. */
  routeGet?: (dst: string, from: string) => Promise<{ dev: string | null; table: string | null } | null>
  ipBinary?: () => string | null
  hasCap?: () => boolean
  defaultRoutes?: () => string[]
  /** NetworkManager's state per interface (nmcli), {} when unknown. */
  nmDevices?: () => Promise<Record<string, NmDevice>>
  /** A /proc/sys value ("net/ipv4/conf/all/arp_ignore"), null when unreadable. */
  sysctl?: (key: string) => string | null
  http?: HttpFn
  drivers?: Record<string, SwitchDriver>
  /** Is a TCP port open (switch sweep)? */
  tcpOpen?: (host: string, port: number, localAddress: string | null) => Promise<boolean>
  adapterPollMs?: number
  reconcileMs?: number
  switchPollMs?: number
  now?: () => Date
  /** Called after the app labels an adapter itself; wired to the accesses service so every label cache and open Cables page refresh. */
  onLabelsChanged?: () => Promise<void>
}

type Row = Awaited<ReturnType<ServiceDeps["prisma"]["equipmentNetwork"]["upsert"]>>
const Dot1qSchema = z.object({
  enabled: z.boolean(), portCount: z.number().int().min(1).max(64),
  vlans: z.array(z.object({ vid: z.number().int(), name: z.string(), untagged: z.array(z.number().int()), tagged: z.array(z.number().int()) })),
  pvids: z.array(z.number().int()),
})
const FACTORY = { username: "admin", password: "admin" }
const RECENT_LINK_MS = 10 * 60_000
const PREVIEW_TTL_MS = 10 * 60_000
const NM_REFRESH_MS = 30_000

interface Preview { dto: SwitchPreviewDTO; current: Dot1qState; target: Dot1qState; ops: SwitchOp[]; uplinkOk: boolean; at: number; target_: { host: string; username: string; password: string } }

/** How the server talks to the switch on the chosen interface. */
interface MgmtMode { mode: "own" | "reuse" | "none"; plan: MgmtPlan | null; reuse: AddrInfo | null; subnet: string | null }

function tcpOpenDefault(host: string, port: number, localAddress: string | null, timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host, port, ...(localAddress ? { localAddress } : {}) })
    const done = (ok: boolean) => { s.removeAllListeners(); s.destroy(); resolve(ok) }
    s.setTimeout(timeoutMs, () => done(false))
    s.once("connect", () => done(true))
    s.once("error", () => done(false))
  })
}

function sysctlDefault(key: string): string | null {
  if (!/^[a-z0-9_./-]+$/i.test(key) || key.includes("..")) return null
  try { return fs.readFileSync(path.join("/proc/sys", key), "utf8").trim() } catch { return null }
}

const hash = (v: unknown) => crypto.createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 32)
/** Loopback and link-local addresses never clash with the switch or the equipment. */
const ignorable = (a: AddrInfo) => a.ifname === "lo" || a.local.startsWith("127.") || a.local.startsWith("169.254.")
const cidrOf = (a: AddrInfo) => `${a.local}/${a.prefixlen}`

export function createEquipnetServices(deps: ServiceDeps, internals: EquipnetInternals = {}): EquipnetServices {
  const cfg = deps.config
  const log: Logger = deps.log.child("red-equipos")
  const now = internals.now ?? (() => new Date())
  const drivers = internals.drivers ?? switchDrivers(internals.http)
  const scanNet = internals.scanNet ?? (() => scanNetInterfaces(cfg.net.sysRoot))
  const ipBinary = internals.ipBinary ?? (() => findIpBinary(cfg.net.ipBin))
  const readHost = internals.readHost ?? (async () => {
    const bin = ipBinary()
    if (!bin) throw new IpError("ip no encontrado", "", false)
    return readHostState(bin)
  })
  const runIp = internals.runIp ?? (async (cmds: readonly IpCommand[], guard: IpGuard) => {
    const bin = ipBinary()
    if (!bin) throw new IpError("ip no encontrado", "", false)
    await runIpCommands(bin, cmds, guard)
  })
  const routeGet = internals.routeGet ?? (async (dst: string, from: string) => {
    const bin = ipBinary()
    return bin ? routeGetIp(bin, dst, from) : null
  })
  const hasCap = internals.hasCap ?? (() => hasNetAdmin())
  const defaultRoutes = internals.defaultRoutes ?? (() => defaultRouteInterfaces())
  const nmDevices = internals.nmDevices ?? readNmDevices
  const sysctl = internals.sysctl ?? sysctlDefault
  const tcpOpen = internals.tcpOpen ?? tcpOpenDefault
  const backupDir = path.join(cfg.dataDir, "equipnet")

  let row: Row | null = null
  let ifaces: NetIface[] = []
  let host: HostState | null = null
  let hostStatus: HostNetStatusDTO = { state: "off", detail: null, pending: [], canApply: false, ifname: null, networkManagerHint: null, checkedAt: null }
  let ready: Record<number, boolean> = {}
  /** Per VLAN id: why `ip route get` says its traffic would not leave by its own interface. */
  let vlanProblems: Record<number, string> = {}
  let mgmtProblem: string | null = null
  let mgmtReady = false
  let leftovers: { items: string[]; commands: string[] } = { items: [], commands: [] }
  let nm: Record<string, NmDevice> = {}
  let nmAt = 0
  let swStatus: SwitchStatusDTO = { state: "unconfigured", detail: switchDetail.unconfigured, info: { model: null, hardware: null, firmware: null, mac: null, portCount: null }, dot1qEnabled: null, matches: null, drift: [], checkedAt: null }
  const links = new Map<number, { up: boolean; speed: string | null; upAt: Date | null }>()
  let usage = new Map<number, SwitchPortUseDTO[]>()
  let labels = new Map<string, { id: string; name: string }>()
  let detection: SwitchDetectionDTO | null = null
  let job: SwitchJobDTO | null = null
  const previews = new Map<string, Preview>()
  let session: { key: string; s: SwitchSession } | null = null
  const listeners = new Set<() => void>()
  let timers: NodeJS.Timeout[] = []
  let stopped = true
  let reconciling: Promise<void> | null = null
  let reconcileAgain = false
  let lastLoggedError = ""
  let pollCount = 0
  let publishTimer: NodeJS.Timeout | null = null
  let lastRouteKey = ""

  // --- settings -------------------------------------------------------------------------------------------------

  async function loadRow(): Promise<Row> {
    // A new row takes the equipment IP of the profile (RM_EQUIPNET_EQUIPMENT_IP); without it, an admin sets it.
    row = await deps.prisma.equipmentNetwork.upsert({ where: { id: "global" }, create: { id: "global", equipmentIp: deps.config.defaults.equipmentIp }, update: {} })
    return row
  }
  const r = (): Row => {
    if (!row) throw new Error("Red de equipos no iniciada")
    return row
  }
  const driverId = () => {
    const d = SwitchDriverSchema.safeParse(r().driver)
    return d.success ? d.data : "tplink-easy-smart"
  }
  /** Addresses the server has outside the app's VLAN interfaces: no VLAN address may be one of them. */
  const hostAddresses = (): string[] => (host?.addrs ?? []).filter((a) => !VLAN_IF_RE.test(a.ifname) && !ignorable(a)).map((a) => a.local)
  const plan = (x: Pick<Row, "portCount" | "uplinkPort" | "vlanBase" | "mgmtAddress" | "equipmentIp" | "equipmentPrefix" | "hostOffset"> = r()): EquipnetPlan =>
    planEquipnet(x, { avoid: hostAddresses() })
  const settingsDTO = (): EquipnetSettingsDTO => {
    const x = r()
    return {
      enabled: x.enabled, adapterMac: x.adapterMac, driver: driverId(), switchHost: x.switchHost,
      switchUsername: x.switchUsername, hasPassword: !!x.switchPassword, portCount: x.portCount, uplinkPort: x.uplinkPort,
      vlanBase: x.vlanBase, mgmtAddress: x.mgmtAddress, equipmentIp: x.equipmentIp, equipmentPrefix: x.equipmentPrefix, hostOffset: x.hostOffset,
    }
  }
  const password = (): string | null => {
    const sealed = r().switchPassword
    if (!sealed) return null
    return openSecret(sealed, cfg.authSecret ?? "")
  }

  // --- interfaces -----------------------------------------------------------------------------------------------

  const addrsOf = (ifname: string) => (host?.addrs ?? []).filter((a) => a.ifname === ifname)
  /** The app's management addresses (marked by their table-20000 rule), wherever they are. */
  const marked = (): string[] => (host ? markedMgmtAddresses(host) : [])
  const adapterLabel = (mac: string): string => labels.get(mac)?.name ?? nextCableName("net-adapter", [...labels.values()].map((l) => l.name))
  const chosen = (): NetIface | undefined => (row?.adapterMac ? ifaces.find((i) => i.mac === row?.adapterMac) : undefined)

  /** Can this interface be the one wired to the switch? Never the default route's; others with a warning need a confirmation. */
  function assess(i: NetIface, defaults: readonly string[]): { selectable: NetAdapterDTO["selectable"]; problem: string | null; warning: string | null } {
    if (defaults.includes(i.ifname)) return { selectable: "no", problem: adapterProblem.defaultRoute, warning: null }
    if (i.wireless) return { selectable: "no", problem: adapterProblem.wireless, warning: null }
    const warnings: string[] = []
    if (!i.usb && !cfg.net.allowNonUsb) warnings.push(adapterProblem.notUsb)
    const mg = plan().mgmt
    const ours = marked()
    const other = addrsOf(i.ifname).filter((a) => !ignorable(a) && !ours.includes(a.local) && !(mg && inSubnet(a.local, mg.subnet)))
    if (other.length) warnings.push(adapterProblem.otherAddress(other.map(cidrOf).join(", ")))
    return warnings.length ? { selectable: "confirm", problem: null, warning: warnings.join(" ") } : { selectable: "yes", problem: null, warning: null }
  }

  /**
   * How the server talks to the switch on the chosen interface: an address it already has in the management network
   * is reused as is (nothing added) when no other interface is on that network (that address has no rule of its own,
   * the main table decides); otherwise the app's own address (noprefixroute + its rule, table 20000).
   */
  function mgmtMode(c: NetIface | undefined, p: EquipnetPlan = plan(), driver: string = driverId()): MgmtMode {
    const mg = p.mgmt
    if (!c || driver !== "tplink-easy-smart" || !mg) return { mode: "none", plan: null, reuse: null, subnet: null }
    const ours = marked()
    const reuse = addrsOf(c.ifname).find((a) => !ours.includes(a.local) && inSubnet(a.local, mg.subnet))
    if (reuse) {
      const sub = subnetOf(reuse.local, reuse.prefixlen)
      const clash = (host?.addrs ?? []).some((a) => a.ifname !== c.ifname && !VLAN_IF_RE.test(a.ifname) && !ignorable(a) && overlaps(subnetOf(a.local, a.prefixlen), sub))
      if (!clash) return { mode: "reuse", plan: null, reuse, subnet: subnetOf(reuse.local, Math.max(22, reuse.prefixlen)) }
    }
    return { mode: "own", plan: mg, reuse: null, subnet: mg.subnet }
  }

  /** The source address for the switch management on the chosen interface (ours or the reused one), when in place. */
  function mgmtSource(c: NetIface | undefined): string | null {
    const mm = mgmtMode(c)
    if (!c) return null
    if (mm.mode === "reuse") return mm.reuse?.local ?? null
    if (mm.mode === "own" && mm.plan && addrsOf(c.ifname).some((a) => a.local === mm.plan?.address)) return mm.plan.address
    return null
  }

  /** Address clashes that make the setup impossible (Spanish, with the settings field each one is about). */
  function conflicts(c: NetIface | undefined, v: { switchHost: string | null; mode: MgmtMode; equipmentIp: string | null; enabled: boolean }): Array<{ field: string; message: string }> {
    const out: Array<{ field: string; message: string }> = []
    const addrs = (host?.addrs ?? []).filter((a) => !VLAN_IF_RE.test(a.ifname) && !ignorable(a))
    const ours = marked()
    if (v.switchHost) {
      const a = addrs.find((x) => x.local === v.switchHost)
      if (a) out.push({ field: "switchHost", message: equipnetErrors.switchIpOnHost(v.switchHost, a.ifname, a.prefixlen) })
    }
    const mg = v.mode.mode === "own" ? v.mode.plan : null
    if (mg) {
      if (v.switchHost === mg.address) out.push({ field: "mgmtAddress", message: equipnetErrors.mgmtIsSwitch(mg.address) })
      const a = addrs.find((x) => x.local === mg.address && x.ifname !== c?.ifname)
      if (a) out.push({ field: "mgmtAddress", message: equipnetErrors.mgmtOnOther(mg.address, a.ifname, ours.includes(a.local)) })
    }
    if (v.enabled && v.equipmentIp) {
      const eqIp = v.equipmentIp
      const a = addrs.find((x) => x.local === eqIp)
      if (a) out.push({ field: "equipmentIp", message: equipnetErrors.equipmentIpOnHost(eqIp, a.ifname) })
    }
    return out
  }

  /** It works, but the admin should know: another interface on the equipment or management network, and ARP. */
  function netWarnings(p: EquipnetPlan = plan()): string[] {
    const c = chosen()
    if (!r().adapterMac) return []
    const mm = mgmtMode(c, p)
    const out: string[] = []
    const shared = new Set<string>()
    for (const a of (host?.addrs ?? []).filter((x) => x.ifname !== c?.ifname && !VLAN_IF_RE.test(x.ifname) && !ignorable(x))) {
      const sub = subnetOf(a.local, a.prefixlen)
      if (overlaps(sub, p.subnet)) {
        out.push(netWarning.equipmentOverlap(p.subnet, a.ifname, cidrOf(a)))
        shared.add(a.ifname)
      }
      if (mm.mode === "own" && mm.plan && overlaps(sub, mm.plan.subnet)) {
        out.push(netWarning.mgmtOverlap(mm.plan.subnet, a.ifname, cidrOf(a)))
        shared.add(a.ifname)
      }
    }
    // Linux answers ARP for any of its addresses on any interface unless arp_ignore >= 1 (all or that interface).
    const level = (k: string) => Number(sysctl(k) ?? "0") || 0
    const weak = [...shared].filter((i) => Math.max(level("net/ipv4/conf/all/arp_ignore"), level(`net/ipv4/conf/${i}/arp_ignore`)) < 1)
    if (weak.length) out.push(netWarning.arp(weak.join(", ")))
    return out
  }

  function adaptersDTO(): NetAdapterDTO[] {
    const defaults = defaultRoutes()
    const mg = plan().mgmt
    const ours = marked()
    return ifaces.map((i) => {
      const l = labels.get(i.mac)
      const a = assess(i, defaults)
      const reuse = mg ? addrsOf(i.ifname).find((x) => !ours.includes(x.local) && inSubnet(x.local, mg.subnet)) : undefined
      const n = nm[i.ifname]
      return {
        ifname: i.ifname, mac: i.mac, usb: i.usb, bus: i.bus, wireless: i.wireless, driver: i.driver, vendorId: i.vendorId, productId: i.productId,
        manufacturer: i.manufacturer, product: i.product, location: i.location, carrier: i.carrier, speedMbps: i.speedMbps,
        addresses: addrsOf(i.ifname).map(cidrOf), defaultRoute: defaults.includes(i.ifname),
        nmState: n?.state ?? null, nmConnection: n?.connection ?? null,
        selectable: a.selectable, problem: a.problem, warning: a.warning, mgmtReuse: reuse ? cidrOf(reuse) : null,
        labelId: l?.id ?? null, labelName: l?.name ?? null, chosen: row?.adapterMac === i.mac,
      }
    })
  }

  function otherIfacesDTO(): OtherIfaceDTO[] {
    const phys = new Set(ifaces.map((i) => i.ifname))
    const defaults = defaultRoutes()
    return (host?.links ?? []).filter((l) => l.ifname !== "lo" && !phys.has(l.ifname) && !VLAN_IF_RE.test(l.ifname))
      .map((l) => ({ ifname: l.ifname, kind: l.kind, up: l.up, addresses: addrsOf(l.ifname).map(cidrOf), defaultRoute: defaults.includes(l.ifname) }))
      .sort((a, b) => a.ifname.localeCompare(b.ifname))
  }

  function mgmtDTO(): MgmtStatusDTO {
    const c = chosen()
    const mm = mgmtMode(c)
    if (!c || mm.mode === "none") return { mode: "none", address: null, subnet: null, ifname: c?.ifname ?? null, ready: false, problem: null }
    if (mm.mode === "reuse") return { mode: "reuse", address: mm.reuse ? cidrOf(mm.reuse) : null, subnet: mm.subnet, ifname: c.ifname, ready: true, problem: null }
    const address = mm.plan ? `${mm.plan.address}/${mm.plan.prefix}` : null
    return { mode: "own", address, subnet: mm.subnet, ifname: c.ifname, ready: mgmtReady && !mgmtProblem, problem: mgmtProblem }
  }

  async function loadLabels(): Promise<void> {
    const rows = await deps.prisma.cableLabel.findMany({ where: { kind: "net-adapter" }, select: { id: true, name: true, identity: true } })
    labels = new Map(rows.map((x) => [x.identity, { id: x.id, name: x.name }]))
  }

  async function scanAdapters(): Promise<boolean> {
    let next: NetIface[]
    try { next = await scanNet() } catch (err) {
      log.debug("No se pudieron leer las interfaces de red", { error: String(err) })
      return false
    }
    const key = (xs: NetIface[]) => JSON.stringify(xs.map((i) => [i.ifname, i.mac, i.carrier, i.speedMbps]))
    const changed = key(next) !== key(ifaces)
    ifaces = next
    return changed
  }

  async function refreshNm(): Promise<void> {
    if (Date.now() - nmAt < NM_REFRESH_MS) return
    nmAt = Date.now()
    try { nm = await nmDevices() } catch { nm = {} }
  }

  // --- host networking --------------------------------------------------------------------------------------------

  function nmHint(mac: string | null): string | null {
    if (!mac) return null
    const conf = "/etc/NetworkManager/conf.d/90-relay-manager-red-equipos.conf"
    let nmPresent = false
    try { nmPresent = fs.existsSync("/run/NetworkManager") || fs.existsSync("/etc/NetworkManager/NetworkManager.conf") } catch { /* no */ }
    if (!nmPresent) return null
    try { if (fs.readFileSync(conf, "utf8").toLowerCase().includes(mac)) return null } catch { /* missing */ }
    return hostDetail.nmHint(mac)
  }

  /**
   * Interfaces no `ip` command may name: the default route's, and every interface that is not the chosen one (nor
   * one the admin asked to clean). The last guard (validateIpCommand) refuses any command that names one of them.
   */
  function forbiddenFor(parent: string | null, clean: readonly string[]): string[] {
    const names = new Set([...defaultRoutes(), ...(host?.links ?? []).map((l) => l.ifname), ...ifaces.map((i) => i.ifname)])
    return [...names].filter((n) => (n !== parent || defaultRoutes().includes(n)) && !VLAN_IF_RE.test(n) && !clean.includes(n) && !/^\d+$/.test(n))
  }

  /**
   * What older versions left behind, as lines for the admin and the commands that remove it. `chosenIf` null: no
   * interface chosen (everything of the app is a leftover); "" or a name: only its management addresses elsewhere.
   */
  function leftoversOf(h: HostState, chosenIf: string | null, p: EquipnetPlan): { items: string[]; commands: string[] } {
    const items: string[] = []
    const ours = markedMgmtAddresses(h)
    const lostAddrs: Leftover[] = h.addrs.filter((a) => ours.includes(a.local) && a.ifname !== chosenIf && !VLAN_IF_RE.test(a.ifname))
      .map((a) => ({ ifname: a.ifname, address: a.local, prefixlen: a.prefixlen }))
    for (const a of lostAddrs) items.push(`${a.address}/${a.prefixlen} en ${a.ifname} (dirección de gestión de la red de equipos)`)
    if (chosenIf === null) {
      // Nothing chosen: everything of the app is a leftover.
      for (const l of h.links.filter((x) => VLAN_IF_RE.test(x.ifname))) items.push(`interfaz ${l.ifname}${l.parent ? ` sobre ${l.parent}` : ""}`)
      for (const x of h.rules.filter(ownedRule)) items.push(`regla ${x.priority}: desde ${x.src ?? "todo"} → tabla ${x.table ?? "?"}`)
      const tables = [...new Set(h.routes.filter((x) => ownedTable(x.table)).map((x) => x.table))]
      if (tables.length) items.push(`${tables.length === 1 ? "tabla de rutas" : "tablas de rutas"} ${tables.join(", ")}`)
      if (!items.length) return { items, commands: [] }
      const t = planHost({ parent: null, mgmt: null, vlans: [], subnet: p.subnet, prefix: p.prefix, cleanup: [...new Set(lostAddrs.map((a) => a.ifname))] }, h)
      return { items, commands: t.commands.map(commandText) }
    }
    return { items, commands: lostAddressCommands(h, lostAddrs).map(commandText) }
  }

  /** Removing management addresses of the app from other interfaces: the address, then the rules that mark it. */
  function lostAddressCommands(h: HostState, lost: readonly Leftover[]): IpCommand[] {
    const out: IpCommand[] = []
    for (const a of lost) {
      out.push(["addr", "del", `${a.address}/${a.prefixlen}`, "dev", a.ifname])
      for (const x of h.rules.filter((y) => ownedRule(y) && y.src === a.address)) out.push(["rule", "del", "pref", String(x.priority), "from", `${a.address}/32`, "lookup", x.table ?? ""])
    }
    return out
  }

  /** Interfaces whose leftovers the admin asked to remove (consumed by the next reconcile pass). */
  let cleanupRequest: string[] | null = null

  async function reconcile(reason: string): Promise<void> {
    if (stopped || !row) return
    if (reconciling) {
      reconcileAgain = true
      return reconciling
    }
    reconciling = (async () => {
      do {
        reconcileAgain = false
        await reconcileOnce(reason)
      } while (reconcileAgain && !stopped)
    })().finally(() => { reconciling = null })
    return reconciling
  }

  async function reconcileOnce(reason: string): Promise<void> {
    const x = r()
    const checkedAt = now().toISOString()
    const c = chosen()
    const label = x.adapterMac ? adapterLabel(x.adapterMac) : ""
    const base = { ifname: c?.ifname ?? null, networkManagerHint: x.enabled ? nmHint(x.adapterMac) : null, checkedAt }
    const cleanup = cleanupRequest
    cleanupRequest = null
    await refreshNm()
    const fail = (state: HostNetStatusDTO["state"], detail: string) => {
      hostStatus = { state, detail, pending: [], canApply: false, ...base }
      vlanProblems = {}
      mgmtProblem = null
      mgmtReady = false
      setReady({})
      schedulePublish()
    }
    if (!ipBinary()) return fail("no-ip-tool", hostDetail.noIpTool)
    try {
      host = await readHost()
    } catch (err) {
      return fail("error", hostDetail.failed(err instanceof Error ? err.message : String(err)))
    }
    const p = plan()
    const defaults = defaultRoutes()
    const clean = (cleanup ?? []).filter((n) => !defaults.includes(n))
    const cap = hasCap()
    const canApply = cfg.net.hostMode === "apply" && cap

    // What to do. Nothing at all until the admin chose an interface (only an explicit "Quitar restos" tears down).
    let d: HostDesired | null = null
    let why: string | null = null
    if (!x.adapterMac) {
      if (cleanup) d = { parent: null, mgmt: null, vlans: [], subnet: p.subnet, prefix: p.prefix, cleanup: clean }
    } else if (c) {
      const a = assess(c, defaults)
      const mm = mgmtMode(c, p)
      const conf = conflicts(c, { switchHost: x.switchHost, mode: mm, equipmentIp: x.equipmentIp, enabled: x.enabled })
      if (a.selectable === "no") why = hostDetail.blocked(a.problem ?? "")
      else if (Object.keys(p.errors).length) why = Object.values(p.errors).flat()[0] ?? null
      else if (conf.length) why = conf[0]?.message ?? null
      else d = { parent: c.ifname, mgmt: mm.mode === "own" ? mm.plan : null, vlans: x.enabled ? p.ports : [], subnet: p.subnet, prefix: p.prefix, cleanup: clean }
    }
    const guard = (dd: HostDesired): IpGuard => ({
      parent: dd.parent && !defaults.includes(dd.parent) ? dd.parent : null, forbidden: forbiddenFor(dd.parent, clean), cleanup: clean,
    })

    let hp = d ? planHost(d, host) : null
    let applyError: string | null = null
    if (d && hp && hp.commands.length && canApply) {
      try {
        await runIp(hp.commands, guard(d))
        log.info(equipnetLog.hostApplied, { cambios: hp.commands.length, motivo: reason, adaptador: d.parent ?? "-" })
        deps.audit.record({ actor: SYSTEM_ACTOR, action: "equipnet.host", target: { type: "network", name: d.parent ?? "red-equipos" }, detail: { commands: hp.commands.map(commandText).slice(0, 60), reason } })
        lastLoggedError = ""
      } catch (err) {
        applyError = err instanceof Error ? err.message : String(err)
        if (applyError !== lastLoggedError) log.warn(equipnetLog.hostFailed, { error: applyError })
        lastLoggedError = applyError
      }
      try { host = await readHost() } catch { /* keep the old one */ }
      if (host) hp = planHost(d, host)
    }
    // With an interface chosen (even unplugged), only the app's addresses on OTHER interfaces are leftovers.
    leftovers = host ? leftoversOf(host, x.adapterMac ? c?.ifname ?? "" : null, p) : { items: [], commands: [] }
    if (!x.adapterMac && !cleanup) hp = null

    // Verify with the kernel's own route lookup: from each VLAN address the equipment must be reached through that
    // VLAN (any rule of the system that sorts before the app's and sends it elsewhere shows up here).
    const nextProblems: Record<number, string> = {}
    mgmtProblem = null
    if (d?.parent && hp) {
      const plan0 = hp
      const eqIp = x.equipmentIp
      await Promise.all(d.vlans.filter((v) => eqIp && plan0.ready[v.vid]).map(async (v) => {
        const g = await routeGet(eqIp ?? "", v.hostAddress)
        if (!g || g.dev !== v.ifname) nextProblems[v.vid] = equipnetErrors.vlanShadowed(v.vid, g?.dev ?? null)
      }))
      if (d.mgmt && hp.mgmtReady && x.switchHost && inSubnet(x.switchHost, d.mgmt.subnet)) {
        const g = await routeGet(x.switchHost, d.mgmt.address)
        if (!g || g.dev !== d.parent) mgmtProblem = equipnetErrors.mgmtShadowed(g?.dev ?? null, d.parent)
      }
    }
    vlanProblems = nextProblems
    mgmtReady = !!hp?.mgmtReady

    const pending = hp ? hp.commands.map(commandText) : []
    const nReady = hp ? Object.entries(hp.ready).filter(([vid, ok]) => ok && !nextProblems[Number(vid)]).length : 0
    let state: HostNetStatusDTO["state"]
    let detail: string | null
    if (!x.adapterMac && !pending.length) {
      state = "off"
      detail = leftovers.items.length ? hostDetail.leftovers : hostDetail.off
    } else if (x.adapterMac && !c) {
      state = "no-adapter"
      detail = hostDetail.noAdapter(label)
    } else if (why) {
      state = "blocked"
      detail = why
    } else if (!pending.length) {
      state = x.enabled ? (Object.keys(nextProblems).length || mgmtProblem ? "error" : "ok") : "off"
      detail = !x.enabled ? hostDetail.chosenOnly(label)
        : Object.keys(nextProblems).length ? hostDetail.shadowed(Object.keys(nextProblems).length)
          : mgmtProblem ?? hostDetail.ok(nReady, label)
      if (x.enabled && c?.carrier === false) detail = hostDetail.noCarrier(label)
    } else if (cfg.net.hostMode === "off") {
      state = "no-permission"
      detail = hostDetail.hostModeOff
    } else if (!cap) {
      state = "no-permission"
      detail = hostDetail.noPermission
    } else if (applyError) {
      state = "error"
      detail = hostDetail.failed(applyError)
    } else {
      state = "pending"
      detail = hostDetail.pending(pending.length)
    }
    hostStatus = { state, detail, pending, canApply, ...base }
    const eff: Record<number, boolean> = {}
    for (const [vid, ok] of Object.entries(hp?.ready ?? {})) eff[Number(vid)] = ok && !nextProblems[Number(vid)] && !why
    setReady(eff)
    schedulePublish()
  }

  function setReady(next: Record<number, boolean>): void {
    ready = next
    notifyRoutes()
  }

  // --- switch ---------------------------------------------------------------------------------------------------

  function sessionTarget(over?: { host?: string; username?: string; password?: string }): { host: string; username: string; password: string; source: string | null } | null {
    const x = r()
    const h = over?.host ?? x.switchHost
    const pw = over?.password ?? password()
    if (!h || !pw) return null
    return { host: h, username: over?.username ?? x.switchUsername ?? FACTORY.username, password: pw, source: mgmtSource(chosen()) }
  }

  async function openSession(over?: { host?: string; username?: string; password?: string }): Promise<SwitchSession> {
    const t = sessionTarget(over)
    if (!t) throw new DomainError("VALIDATION", switchDetail.noPassword, { password: [switchDetail.noPassword] })
    const d = drivers[driverId()]
    if (!d?.automatic) throw new DomainError("VALIDATION", equipnetErrors.notAutomatic)
    return d.open({ host: t.host, httpPort: cfg.net.switchHttpPort, localAddress: t.source, username: t.username, password: t.password })
  }

  async function pollSession(): Promise<SwitchSession | null> {
    const t = sessionTarget()
    if (!t) return null
    const key = JSON.stringify(t)
    if (session && session.key === key) return session.s
    if (session) await session.s.close().catch(() => undefined)
    session = null
    const s = await openSession()
    session = { key, s }
    return s
  }

  async function closeSession(): Promise<void> {
    const s = session
    session = null
    if (s) await s.s.close().catch(() => undefined)
  }

  function switchErrorStatus(err: unknown): Pick<SwitchStatusDTO, "state" | "detail"> {
    if (err instanceof SwitchError) return { state: err.code === "auth-failed" ? "auth-failed" : err.code === "unreachable" ? "unreachable" : "error", detail: err.message }
    if (err instanceof DomainError) return { state: "error", detail: err.message }
    return { state: "error", detail: err instanceof Error ? err.message : String(err) }
  }

  let pollInFlight: Promise<void> | null = null
  /** «Buscar el switch» in progress: no status polling meanwhile (the switch has one session per client IP). */
  let discovering = false
  function pollSwitch(): Promise<void> {
    if (discovering) return Promise.resolve()
    pollInFlight ??= pollSwitchOnce().finally(() => { pollInFlight = null })
    return pollInFlight
  }

  async function pollSwitchOnce(): Promise<void> {
    if (stopped || !row || job?.state === "running") return
    const x = r()
    if (driverId() === "manual") {
      swStatus = { ...swStatus, state: "manual", detail: switchDetail.manual }
      return schedulePublish()
    }
    // Never through an interface the admin did not choose.
    if (!x.adapterMac) {
      swStatus = { ...swStatus, state: "unconfigured", detail: equipnetErrors.chooseFirst }
      return schedulePublish()
    }
    if (!x.switchHost || !x.switchPassword) {
      swStatus = { ...swStatus, state: "unconfigured", detail: !x.switchHost ? switchDetail.unconfigured : switchDetail.noPassword }
      return schedulePublish()
    }
    if (x.switchPassword && password() === null) {
      swStatus = { ...swStatus, state: "auth-failed", detail: switchDetail.badPassword }
      return schedulePublish()
    }
    pollCount++
    try {
      const s = await pollSession()
      if (!s) return
      const l = await s.links()
      let changedLink = false
      for (const p of l) {
        const before = links.get(p.port)
        const upAt = p.linkUp ? (before && !before.up ? now() : before?.upAt ?? null) : null
        if (before && before.up !== p.linkUp) {
          changedLink = true
          log.info(equipnetLog.linkChanged, { puerto: p.port, enlace: p.linkUp ? "activo" : "sin enlace" })
        }
        if (!before) changedLink = true
        links.set(p.port, { up: p.linkUp, speed: p.speed, upAt })
      }
      if (pollCount % 6 === 1 || swStatus.state !== "ok") {
        const info = await s.info()
        const q = await s.dot1q()
        const applied = Dot1qSchema.safeParse(x.appliedLayout)
        const drift = applied.success ? layoutDrift(q, applied.data) : []
        swStatus = {
          state: "ok", detail: drift.length ? switchDetail.drift(drift.length) : null,
          info: { model: info.model, hardware: info.hardware, firmware: info.firmware, mac: info.mac, portCount: info.portCount },
          dot1qEnabled: q.enabled, matches: applied.success ? drift.length === 0 : null, drift: drift.map(driftLine), checkedAt: now().toISOString(),
        }
        if (info.portCount && info.portCount !== x.portCount && !x.appliedAt) {
          row = await deps.prisma.equipmentNetwork.update({ where: { id: "global" }, data: { portCount: info.portCount, switchModel: info.model, switchFirmware: info.firmware, switchMac: info.mac } })
        } else if (info.model !== x.switchModel || info.firmware !== x.switchFirmware) {
          row = await deps.prisma.equipmentNetwork.update({ where: { id: "global" }, data: { switchModel: info.model, switchFirmware: info.firmware, switchMac: info.mac } })
        }
      } else swStatus = { ...swStatus, state: "ok", checkedAt: now().toISOString() }
      if (changedLink) notifyRoutes()
      schedulePublish()
    } catch (err) {
      await closeSession()
      const e = switchErrorStatus(err)
      const hadLinks = links.size > 0
      links.clear()
      swStatus = { ...swStatus, ...e, checkedAt: now().toISOString() }
      if (hadLinks) notifyRoutes()
      schedulePublish()
    }
  }

  function driftLine(d: ReturnType<typeof layoutDrift>[number]): string {
    switch (d.kind) {
      case "disabled": return driftText.disabled
      case "vlan-missing": return driftText.vlanMissing(d.vid ?? 0)
      case "vlan-members": return driftText.vlanMembers(d.vid ?? 0)
      case "vlan-extra": return driftText.vlanExtra(d.vid ?? 0)
      case "pvid": return driftText.pvid(d.port ?? 0, d.expected ?? 0, d.actual ?? 0)
    }
  }

  // --- «Buscar el switch» (only on the chosen interface) ------------------------------------------------------------

  /**
   * Sweep of the management network of the chosen interface (max /22), always from its own address there, so the
   * probes can only leave through it: the stored switch IP and the factory one first. Never the server's own addresses.
   */
  async function sweep(source: string, subnet: string, first: string[]): Promise<string | null> {
    const d = drivers["tplink-easy-smart"]
    const c = parseCidr(subnet)
    if (!c || !d) return null
    const size = 2 ** (32 - c.prefix)
    if (size > 1024) return null
    const net0 = parseIPv4(c.network) ?? 0
    const all = range(1, size - 2).map((i) => formatIPv4((net0 + i) >>> 0))
    const own = new Set((host?.addrs ?? []).map((a) => a.local))
    const order = [...new Set([...first.filter((h) => inSubnet(h, subnet)), ...all])].filter((h) => h !== source && !own.has(h))
    const port = cfg.net.switchHttpPort
    let found: string | null = null
    let i = 0
    const worker = async () => {
      while (!found && i < order.length) {
        const h = order[i++]
        if (await tcpOpen(h, port, source) && !found && await d.fingerprint(h, port, source)) found = h
      }
    }
    await Promise.all(range(1, 32).map(() => worker()))
    return found
  }

  /** Model, ports and whether the stored (or factory) credentials work. */
  async function identify(h: string, c: NetIface, source: string | null): Promise<SwitchDetectionDTO> {
    const x = r()
    let model: string | null = null
    let portCount: number | null = null
    let loginOk: boolean | null = null
    try {
      const s = await drivers["tplink-easy-smart"].open({ host: h, httpPort: cfg.net.switchHttpPort, localAddress: source, username: x.switchUsername ?? FACTORY.username, password: password() ?? FACTORY.password })
      try {
        const info = await s.info()
        model = info.model
        portCount = info.portCount
        loginOk = true
      } finally { await s.close() }
    } catch (err) {
      loginOk = err instanceof SwitchError && err.code === "auth-failed" ? false : null
    }
    log.info(equipnetLog.switchFound, { ip: h, modelo: model ?? "?", adaptador: c.ifname })
    return { host: h, adapterMac: c.mac, adapterIfname: c.ifname, adapterLabel: adapterLabel(c.mac), model, portCount, loginOk, at: now().toISOString() }
  }

  async function discover(typed: string | null, actor: ActorRef): Promise<SwitchDetectionDTO | null> {
    const x = r()
    if (!x.adapterMac) throw new DomainError("VALIDATION", equipnetErrors.chooseFirst)
    if (driverId() !== "tplink-easy-smart") throw new DomainError("VALIDATION", equipnetErrors.notAutomatic)
    await scanAdapters()
    const c = chosen()
    if (!c) throw new DomainError("VALIDATION", equipnetErrors.adapterMissing)
    // The management address in place first (on the chosen interface only).
    await reconcile("buscar switch")
    const conf = conflicts(c, { switchHost: typed ?? x.switchHost, mode: mgmtMode(c), equipmentIp: x.equipmentIp, enabled: false })
    if (conf.length) throw new DomainError("VALIDATION", conf[0]?.message ?? "", { host: conf.map((x) => x.message) })
    const source = mgmtSource(c)
    const mm = mgmtMode(c)
    if (!typed && (!source || !mm.subnet)) throw new DomainError("VALIDATION", equipnetErrors.noMgmtSource(c.ifname))
    // The switch ties its session to the client IP: while logged in, its home page is not the login page and the
    // fingerprint would miss it. Pause the status polling and log out first (the polling logs in again afterwards).
    let h: string | null
    discovering = true
    try {
      if (pollInFlight) await pollInFlight
      await closeSession()
      if (typed) {
        // Only the IP the admin typed (one connection; from the interface's address when it has one).
        const d = drivers["tplink-easy-smart"]
        h = await tcpOpen(typed, cfg.net.switchHttpPort, source) && await d.fingerprint(typed, cfg.net.switchHttpPort, source) ? typed : null
      } else {
        h = source && mm.subnet ? await sweep(source, mm.subnet, [x.switchHost ?? "", "192.168.0.1"].filter(Boolean)) : null
      }
    } finally { discovering = false }
    deps.audit.record({ actor, action: "equipnet.discover", target: { type: "switch", name: h ?? "-" }, detail: { adapter: c.mac, interface: c.ifname, subnet: typed ? null : mm.subnet, typed, found: h } })
    if (!h) {
      detection = null
      schedulePublish()
      return null
    }
    detection = await identify(h, c, source)
    // Remember it (the next steps and the status polling use it).
    const data: { switchHost: string; portCount?: number } = { switchHost: h }
    if (detection.portCount && !x.appliedAt) data.portCount = detection.portCount
    if (x.switchHost !== h || (data.portCount && data.portCount !== x.portCount)) {
      row = await deps.prisma.equipmentNetwork.update({ where: { id: "global" }, data })
      await closeSession()
      links.clear()
      pollCount = 0
      void pollSwitch()
    }
    schedulePublish()
    return detection
  }

  // --- ports, routes ----------------------------------------------------------------------------------------------

  const linkOf = (port: number): LinkState => {
    const l = links.get(port)
    return !l ? "unknown" : l.up ? "up" : "down"
  }

  function portsDTO(exceptEquipment: string | null = null): SwitchPortDTO[] {
    const x = r()
    const p = plan()
    return range(1, x.portCount).map((port) => {
      const pp = p.ports.find((q) => q.port === port)
      const l = links.get(port)
      return {
        port, role: port === x.uplinkPort ? "uplink" as const : "equipment" as const,
        vid: pp?.vid ?? null, ifname: pp?.ifname ?? null, hostAddress: pp?.hostAddress ?? null,
        link: linkOf(port), speed: l?.speed ?? null, linkUpAt: l?.upAt?.toISOString() ?? null,
        usedBy: (usage.get(port) ?? []).filter((u) => u.equipmentId !== exceptEquipment),
        hostReady: pp ? !!ready[pp.vid] : false,
      }
    })
  }

  function route(port: number): EquipnetRoute {
    const x = r()
    const p = plan()
    const pp = p.ports.find((q) => q.port === port)
    const base = { vid: pp?.vid ?? null, localAddress: pp?.hostAddress ?? null, link: linkOf(port), equipmentIp: x.equipmentIp }
    if (!x.enabled || !x.adapterMac) return { ...base, configured: false, ready: false, problem: "La red de equipos no está activada (Sistema › Red de equipos)." }
    if (!x.equipmentIp) return { ...base, configured: false, ready: false, problem: equipnetErrors.equipmentIpMissing }
    if (!pp) {
      return { ...base, configured: false, ready: false, problem: port === x.uplinkPort ? equipnetErrors.portIsUplink(port) : equipnetErrors.portOutOfRange(x.portCount) }
    }
    const ok = !!ready[pp.vid]
    return { ...base, configured: true, ready: ok, problem: ok ? null : vlanProblems[pp.vid] ?? hostStatus.detail ?? equipnetErrors.vlanNotReady(port) }
  }

  function notifyRoutes(): void {
    // The VLAN addresses too: one may move when another interface takes its address (the forwards must follow).
    const key = JSON.stringify([ready, vlanProblems, row ? plan().ports.map((p) => p.hostAddress) : [], [...links].map(([p, l]) => [p, l.up]), row?.enabled, row?.adapterMac, row?.equipmentIp, row?.vlanBase, row?.uplinkPort, row?.portCount, row?.hostOffset])
    if (key === lastRouteKey) return
    lastRouteKey = key
    for (const l of listeners) {
      try { l() } catch (err) { log.error("Error al avisar de un cambio de la red de equipos", { err }) }
    }
  }

  async function loadUsage(): Promise<void> {
    const rows = await deps.prisma.equipmentAccess.findMany({
      where: { kind: "tcp", targetMode: "switch", switchPort: { not: null } },
      select: { id: true, key: true, switchPort: true, equipmentId: true, equipment: { select: { name: true } } },
    })
    const m = new Map<number, SwitchPortUseDTO[]>()
    for (const a of rows) {
      if (a.switchPort === null) continue
      m.set(a.switchPort, [...(m.get(a.switchPort) ?? []), { equipmentId: a.equipmentId, equipmentName: a.equipment.name, accessId: a.id, key: a.key }])
    }
    usage = m
  }

  // --- status and events ------------------------------------------------------------------------------------------

  function statusDTO(): EquipnetStatusDTO {
    const x = r()
    const defaults = defaultRoutes()
    const unconfigured = ifaces.some((i) => i.usb && !i.wireless && !defaults.includes(i.ifname))
    return {
      settings: settingsDTO(), adapters: adaptersDTO(), otherInterfaces: otherIfacesDTO(), mgmt: mgmtDTO(), warnings: netWarnings(), leftovers,
      host: hostStatus, switch: swStatus, ports: portsDTO(), detection,
      offerSetup: !x.adapterMac && (unconfigured || leftovers.items.length > 0), job,
      appliedAt: x.appliedAt?.toISOString() ?? null, previousAt: x.previousAt?.toISOString() ?? null,
      hasBackup: !!backupPath(), hostMode: cfg.net.hostMode,
    }
  }

  function schedulePublish(): void {
    if (publishTimer || stopped) return
    publishTimer = setTimeout(() => {
      publishTimer = null
      if (!row) return
      deps.bus.publish({ type: "equipnet.changed", status: statusDTO() }, { kind: "admins" })
    }, 150)
    publishTimer.unref()
  }

  function backupPath(): string | null {
    const f = row?.backupFile
    if (!f || !/^switch-[0-9TZ]+\.cfg$/.test(f)) return null
    const p = path.join(backupDir, f)
    return fs.existsSync(p) ? p : null
  }

  // --- preview / apply ------------------------------------------------------------------------------------------

  function portPlanDTO(current: Dot1qState, target: Dot1qState): SwitchPortPlanDTO[] {
    const x = r()
    const fmt = (s: Dot1qState, port: number) => {
      if (!s.enabled) return "sin VLAN (switch plano)"
      const m = portMembership(s, port)
      return [m.untagged.length ? `${portList(m.untagged)} sin etiqueta` : "", m.tagged.length ? `${portList(m.tagged)} con etiqueta` : ""].filter(Boolean).join(" · ") || "ninguna"
    }
    return range(1, target.portCount).map((port) => ({
      port, role: port === x.uplinkPort ? "uplink" : "equipment",
      before: { pvid: current.enabled ? current.pvids[port - 1] ?? null : null, vlans: fmt(current, port) },
      after: { pvid: target.enabled ? target.pvids[port - 1] ?? null : null, vlans: fmt(target, port) },
    }))
  }

  async function buildPreview(kind: SwitchJobKind, s: SwitchSession, creds: Preview["target_"]): Promise<Preview> {
    const x = r()
    const info = await s.info()
    const current = await s.dot1q()
    const lagPorts = (await s.links()).filter((l) => l.lag).map((l) => l.port)
    const p = plan({ ...x, portCount: info.portCount })
    let target: Dot1qState
    const warnings: string[] = []
    let blocked: string | null = null
    if (kind === "apply") target = targetLayout(p.ports, { portCount: info.portCount, uplinkPort: x.uplinkPort })
    else if (kind === "remove") target = { enabled: false, portCount: info.portCount, vlans: [], pvids: range(1, info.portCount).map(() => 1) }
    else {
      const prev = Dot1qSchema.safeParse(x.previousConfig)
      if (!prev.success) {
        blocked = switchJob.noPrevious
        target = current
      } else target = prev.data
      warnings.push(switchJob.portBasedNotRestored)
    }
    if (Object.keys(p.errors).length) blocked = Object.values(p.errors).flat()[0] ?? blocked
    if (lagPorts.length) blocked = switchDetail.lag(portList(lagPorts))
    const ops = blocked ? [] : planSwitchOps(current, target)
    // Which port is this server on? (only matters when the result uses VLANs)
    let uplinkCheck: SwitchPreviewDTO["uplinkCheck"] = { detected: null, expected: x.uplinkPort, ok: true, detail: "" }
    if (target.enabled && ops.length) {
      const det = await detectServerPort(s)
      if (det.port === null) uplinkCheck = { detected: null, expected: x.uplinkPort, ok: false, detail: switchJob.uplinkUnknown(x.uplinkPort) }
      else if (det.port !== x.uplinkPort) {
        uplinkCheck = { detected: det.port, expected: x.uplinkPort, ok: false, detail: switchJob.uplinkMismatch(det.port, x.uplinkPort) }
        blocked ??= uplinkCheck.detail
      } else uplinkCheck = { detected: det.port, expected: x.uplinkPort, ok: true, detail: switchJob.uplinkOk(det.port) }
      if (!keepsManagement(target, uplinkCheck.detected ?? x.uplinkPort)) blocked ??= switchJob.lockout
    }
    const planId = hash({ kind, current, target })
    const dto: SwitchPreviewDTO = {
      kind, planId, changes: ops.map((o) => describeSwitchOp(o)), ports: portPlanDTO(current, target), uplinkCheck, warnings, blocked,
      nothingToDo: !blocked && ops.length === 0,
    }
    const pv: Preview = { dto, current, target, ops, uplinkOk: uplinkCheck.ok, at: Date.now(), target_: creds }
    for (const [k, v] of previews) if (Date.now() - v.at > PREVIEW_TTL_MS) previews.delete(k)
    previews.set(planId, pv)
    return pv
  }

  async function previewWith(kind: SwitchJobKind, over?: { host?: string; username?: string; password?: string }): Promise<Preview> {
    if (driverId() !== "tplink-easy-smart") throw new DomainError("VALIDATION", equipnetErrors.notAutomatic)
    const t = sessionTarget(over)
    if (!t) throw new DomainError("VALIDATION", equipnetErrors.noSwitch, { password: [switchDetail.noPassword] })
    let s: SwitchSession
    try { s = await openSession(over) } catch (err) { throw toDomain(err) }
    try {
      return await buildPreview(kind, s, { host: t.host, username: t.username, password: t.password })
    } catch (err) {
      throw toDomain(err)
    } finally { await s.close().catch(() => undefined) }
  }

  function toDomain(err: unknown): unknown {
    if (err instanceof SwitchError) {
      if (err.code === "auth-failed") return new DomainError("VALIDATION", err.message, { password: [err.message] })
      return new DomainError("DRIVER_ERROR", err.message)
    }
    return err
  }

  function startJob(kind: SwitchJobKind, pv: Preview, actor: ActorRef): SwitchJobDTO {
    if (job?.state === "running") throw new DomainError("CONFLICT", switchJob.busy)
    const j: SwitchJobDTO = { id: crypto.randomUUID(), kind, state: "running", step: 0, total: pv.ops.length + 1, label: switchJob.backup, error: null, warnings: [], startedAt: now().toISOString(), endedAt: null }
    job = j
    schedulePublish()
    void runJob(j, pv, actor)
    return j
  }

  async function runJob(j: SwitchJobDTO, pv: Preview, actor: ActorRef): Promise<void> {
    const action = kindAction(j.kind)
    const x = r()
    let s: SwitchSession | null = null
    let started = false
    const finish = (patch: Partial<SwitchJobDTO>) => {
      job = { ...j, ...patch, endedAt: now().toISOString() }
      schedulePublish()
    }
    try {
      await closeSession()
      s = await drivers[driverId()].open({ host: pv.target_.host, httpPort: cfg.net.switchHttpPort, localAddress: mgmtSource(chosen()), username: pv.target_.username, password: pv.target_.password })
      const current = await s.dot1q()
      if (hash(current) !== hash(pv.current)) throw new DomainError("CONFLICT", switchJob.changed)
      // Backup of the switch's own configuration (it contains its credentials: 0600, admins only).
      try {
        const buf = await s.backup()
        if (buf) {
          fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 })
          const name = `switch-${now().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}.cfg`
          fs.writeFileSync(path.join(backupDir, name), buf, { mode: 0o600 })
          for (const old of fs.readdirSync(backupDir).filter((f) => /^switch-.*\.cfg$/.test(f)).sort().slice(0, -5)) fs.rmSync(path.join(backupDir, old), { force: true })
          row = await deps.prisma.equipmentNetwork.update({ where: { id: "global" }, data: { backupFile: name } })
        }
      } catch (err) {
        log.warn("No se pudo guardar la copia de la configuración del switch", { error: String(err) })
      }
      row = await deps.prisma.equipmentNetwork.update({ where: { id: "global" }, data: { previousConfig: current as unknown as object, previousAt: now() } })
      started = true
      const result = await runSwitchOps(s, current, pv.ops, {
        uplinkPort: x.uplinkPort, optionalVlan1Prune: j.kind === "apply", vlan1PruneWarning: switchJob.vlan1Warning,
        onStep: (p) => {
          job = { ...j, step: p.index + 2, label: switchJob.step(p.index + 1, p.total, describeSwitchOp(p.op)) }
          schedulePublish()
        },
      })
      row = await deps.prisma.equipmentNetwork.update({ where: { id: "global" }, data: { appliedLayout: pv.target as unknown as object, appliedAt: now() } })
      finish({ state: "done", step: j.total, label: switchJob.done[j.kind], warnings: [...(j.kind === "restore" ? pv.dto.warnings : []), ...result.warnings] })
      deps.audit.record({ actor, action, target: { type: "switch", name: x.switchHost ?? "-" }, detail: { changes: pv.dto.changes, warnings: result.warnings } })
    } catch (err) {
      let msg = err instanceof Error ? err.message : String(err)
      if (err instanceof SwitchStepError) {
        msg = switchJob.failed(describeSwitchOp(err.op), err.message)
        if (s && started) {
          const rb = await rollback(s, pv.current, x.uplinkPort)
          msg = `${msg}. ${rb === null ? switchJob.rolledBack : switchJob.rollbackFailed(rb)}`
        }
      }
      finish({ state: "failed", error: msg, label: JOB_KIND_LABEL[j.kind] })
      log.warn("Red de equipos: falló el cambio del switch", { error: msg })
      deps.audit.record({ actor, action, outcome: "error", target: { type: "switch", name: x.switchHost ?? "-" }, detail: { error: msg, changes: pv.dto.changes } })
    } finally {
      if (s) await s.close().catch(() => undefined)
      pollCount = 0
      void pollSwitch()
    }
  }

  const KIND_ACTION: Record<SwitchJobKind, AuditAction> = { apply: "equipnet.switch.apply", restore: "equipnet.switch.restore", remove: "equipnet.switch.remove" }
  const kindAction = (k: SwitchJobKind): AuditAction => KIND_ACTION[k]

  // --- settings save, interface choice, leftovers --------------------------------------------------------------------

  /**
   * Errors that make the settings impossible and warnings that do not. Another interface on the equipment network
   * (or the management network) is only a warning: the app reaches the equipment through its VLANs with rules of its
   * own by source address (noprefixroute), so the rest of the server's traffic to that network is untouched.
   */
  function checkSettings(v: EquipnetSettingsInput): { errors: Record<string, string[]>; warnings: string[] } {
    const x = r()
    const errors: Record<string, string[]> = {}
    const add = (k: string, m: string) => { (errors[k] ??= []).push(m) }
    if (v.enabled && !x.adapterMac) add("enabled", equipnetErrors.enableNeedsAdapter)
    const p = planEquipnet(v, { avoid: hostAddresses() })
    for (const [k, ms] of Object.entries(p.errors)) for (const m of ms) add(k, m)
    const c = chosen()
    if (!Object.keys(p.errors).length) {
      for (const cf of conflicts(c, { switchHost: v.switchHost, mode: mgmtMode(c, p, v.driver), equipmentIp: v.equipmentIp, enabled: v.enabled })) add(cf.field, cf.message)
    }
    return { errors, warnings: Object.keys(p.errors).length ? [] : netWarnings(p) }
  }

  async function saveSettings(input: EquipnetSettingsInput, actor: ActorRef): Promise<{ settings: EquipnetSettingsDTO; warnings: string[] }> {
    const v = EquipnetSettingsInputSchema.parse(input)
    const { errors, warnings } = checkSettings(v)
    if (Object.keys(errors).length) throw new DomainError("VALIDATION", Object.values(errors).flat()[0] ?? "", errors)
    const before = settingsDTO()
    const data = {
      enabled: v.enabled, driver: v.driver, switchHost: v.switchHost, switchUsername: v.switchUsername,
      portCount: v.portCount, uplinkPort: v.uplinkPort, vlanBase: v.vlanBase, mgmtAddress: v.mgmtAddress, equipmentIp: v.equipmentIp,
      equipmentPrefix: v.equipmentPrefix, hostOffset: v.hostOffset, updatedById: actor.id,
      ...(v.switchPassword === undefined ? {} : { switchPassword: v.switchPassword === null ? null : sealSecret(v.switchPassword, cfg.authSecret ?? "") }),
    }
    row = await deps.prisma.equipmentNetwork.update({ where: { id: "global" }, data })
    const after = settingsDTO()
    const changed: Record<string, JsonValue> = {}
    for (const k of Object.keys(after) as Array<keyof EquipnetSettingsDTO>) {
      if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) changed[k] = [before[k] as JsonValue, after[k] as JsonValue]
    }
    if (v.switchPassword !== undefined) changed.switchPassword = v.switchPassword === null ? "borrada" : "cambiada"
    deps.audit.record({ actor, action: "equipnet.update", target: { type: "network", name: "red-equipos" }, detail: { changed, warnings } })
    if (detection && v.switchHost !== detection.host) detection = null
    await closeSession()
    links.clear()
    pollCount = 0
    await reconcile("ajustes")
    void pollSwitch()
    notifyRoutes()
    schedulePublish()
    return { settings: after, warnings }
  }

  /** Step 1, «Usar esta» (or «Dejar de usar»): the only way the app starts touching an interface. */
  async function chooseAdapter(input: { mac: string | null; confirmed: boolean }, actor: ActorRef): Promise<EquipnetStatusDTO> {
    const x = r()
    await scanAdapters()
    try { host = await readHost() } catch { /* the checks use what is known */ }
    const prev = chosen()
    const prevMac = x.adapterMac
    const audit = (detail: Record<string, JsonValue>) =>
      deps.audit.record({ actor, action: "equipnet.update", target: { type: "network", name: "red-equipos" }, detail })
    await closeSession()
    links.clear()
    pollCount = 0
    if (input.mac === null) {
      if (!prevMac) return statusDTO()
      // Stop using it: the app removes what it put there (management address, rmv*, rules and tables), nothing else.
      row = await deps.prisma.equipmentNetwork.update({ where: { id: "global" }, data: { adapterMac: null, enabled: false, updatedById: actor.id } })
      audit({ changed: { adapterMac: [prevMac, null], enabled: [x.enabled, false] }, interface: prev?.ifname ?? null })
      detection = null
      cleanupRequest = prev ? [prev.ifname] : []
      await reconcile("interfaz dejada")
      void pollSwitch()
      notifyRoutes()
      schedulePublish()
      return statusDTO()
    }
    const c = ifaces.find((i) => i.mac === input.mac)
    if (!c) throw new DomainError("VALIDATION", equipnetErrors.adapterMissing, { mac: [equipnetErrors.adapterMissing] })
    const a = assess(c, defaultRoutes())
    if (a.selectable === "no") throw new DomainError("VALIDATION", equipnetErrors.adapterNotAllowed(a.problem ?? ""), { mac: [equipnetErrors.adapterNotAllowed(a.problem ?? "")] })
    if (a.selectable === "confirm" && !input.confirmed) throw new DomainError("CONFIRMATION_REQUIRED", equipnetErrors.needsConfirm(a.warning ?? ""))
    const conf = conflicts(c, { switchHost: x.switchHost, mode: mgmtMode(c), equipmentIp: x.equipmentIp, enabled: false })
    if (conf.length) throw new DomainError("VALIDATION", conf[0]?.message ?? "", { mac: conf.map((y) => y.message) })
    if (prevMac !== c.mac) {
      row = await deps.prisma.equipmentNetwork.update({ where: { id: "global" }, data: { adapterMac: c.mac, updatedById: actor.id } })
      audit({ changed: { adapterMac: [prevMac, c.mac] }, interface: c.ifname, confirmed: input.confirmed, warning: a.warning })
      detection = null
      // The previous interface (if any) is cleaned: the admin moved the network away from it.
      cleanupRequest = prev && prev.ifname !== c.ifname ? [prev.ifname] : null
    }
    await reconcile("interfaz elegida")
    void pollSwitch()
    notifyRoutes()
    schedulePublish()
    return statusDTO()
  }

  /**
   * «Quitar restos»: what older versions left on interfaces the app may not touch on its own. Nothing chosen: a full
   * teardown of the app's objects (next reconcile pass). An interface chosen: only its management addresses (and their
   * rules) on the other interfaces, now.
   */
  async function cleanupLeftovers(actor: ActorRef): Promise<EquipnetStatusDTO> {
    try { host = await readHost() } catch { /* use what is known */ }
    const x = r()
    const c = chosen()
    const h = host
    const ours = h ? markedMgmtAddresses(h) : []
    const defaults = defaultRoutes()
    const lost: Leftover[] = (h?.addrs ?? []).filter((a) => ours.includes(a.local) && a.ifname !== c?.ifname && !VLAN_IF_RE.test(a.ifname) && !defaults.includes(a.ifname))
      .map((a) => ({ ifname: a.ifname, address: a.local, prefixlen: a.prefixlen }))
    const ifs = [...new Set(lost.map((a) => a.ifname))]
    const items = leftovers.items
    if (!items.length && !ifs.length) return statusDTO()
    deps.audit.record({ actor, action: "equipnet.update", target: { type: "network", name: "red-equipos" }, detail: { leftoversRemoved: items, interfaces: ifs } })
    if (!x.adapterMac || !h) {
      cleanupRequest = ifs
    } else if (lost.length && cfg.net.hostMode === "apply" && hasCap()) {
      const cmds = lostAddressCommands(h, lost)
      try {
        await runIp(cmds, { parent: null, forbidden: forbiddenFor(null, ifs), cleanup: ifs })
        deps.audit.record({ actor: SYSTEM_ACTOR, action: "equipnet.host", target: { type: "network", name: ifs.join(", ") }, detail: { commands: cmds.map(commandText), reason: "quitar restos" } })
      } catch (err) {
        throw new DomainError("DRIVER_ERROR", hostDetail.failed(err instanceof Error ? err.message : String(err)))
      }
    }
    await reconcile("quitar restos")
    return statusDTO()
  }

  async function ensureAdapterLabel(mac: string, actor: ActorRef): Promise<void> {
    if (labels.has(mac)) return
    const i = ifaces.find((x) => x.mac === mac)
    const name = adapterLabel(mac)
    const t = now()
    try {
      const l = await deps.prisma.cableLabel.create({ data: { kind: "net-adapter", identity: mac, name, vendorId: i?.vendorId ?? null, productId: i?.productId ?? null, product: i?.product ?? null, firstSeenAt: t, lastSeenAt: t } })
      deps.audit.record({ actor, action: "cable.label.create", target: { type: "cable", id: l.id, name }, detail: { kind: "net-adapter", identity: mac, product: i?.product ?? null } })
      await loadLabels()
      if (internals.onLabelsChanged) await internals.onLabelsChanged()
    } catch (err) {
      log.debug("No se pudo etiquetar el adaptador de red", { error: String(err) })
    }
  }

  // --- health ----------------------------------------------------------------------------------------------------

  function health(): HealthCheckDTO[] {
    const x = r()
    const mk = (id: string, label: string, level: HealthCheckDTO["level"], message: string, hint: string | null = null): HealthCheckDTO => ({ id, group: "network", level, label, message, hint })
    const out: HealthCheckDTO[] = []
    if (leftovers.items.length) {
      out.push(mk("equipnet.leftovers", "Restos de la red de equipos", "warn", leftovers.items.join("; "), `Sistema › Red de equipos: «Quitar restos» (o como root: ${leftovers.commands.slice(0, 3).map((c) => `sudo ${c}`).join("; ")})`))
    }
    if (!x.adapterMac) {
      const any = statusDTO().offerSetup
      out.push(mk("equipnet.adapter", "Red de equipos", "info", any ? "Hay adaptadores de red sin configurar" : "Sin configurar", any ? "Sistema › Red de equipos: elige la interfaz del switch" : null))
      return out
    }
    const c = chosen()
    const label = adapterLabel(x.adapterMac)
    out.push(!c
      ? mk("equipnet.adapter", "Interfaz de la red de equipos", "fail", `${label} (${x.adapterMac}) no está conectada`, "Conecta el adaptador USB-Ethernet del switch")
      : c.carrier === false
        ? mk("equipnet.adapter", "Interfaz de la red de equipos", "warn", `${label} (${c.ifname}) sin enlace`, "Comprueba el cable del adaptador al puerto de subida del switch")
        : mk("equipnet.adapter", "Interfaz de la red de equipos", "ok", `${label} (${c.ifname}, ${c.product ?? c.driver ?? "tarjeta de red"})${c.speedMbps ? ` a ${c.speedMbps} Mb/s` : ""}`))
    const hs = hostStatus
    out.push(mk("equipnet.host", "Red del servidor (VLAN)", hs.state === "ok" ? "ok" : hs.state === "off" ? "info" : hs.state === "pending" ? "warn" : "fail", hs.detail ?? "",
      hs.pending.length ? hs.pending.slice(0, 3).map((p) => `sudo ${p}`).join("; ") : Object.values(vlanProblems)[0] ?? null))
    out.push(mk("equipnet.permission", "Permiso CAP_NET_ADMIN", hasCap() ? "ok" : cfg.net.hostMode === "off" ? "info" : "warn",
      hasCap() ? "El servicio puede preparar la red de equipos" : cfg.net.hostMode === "off" ? "RM_NET_HOST=off: la red del servidor la preparas tú" : "El servicio no puede cambiar la red del servidor", hasCap() ? null : hostDetail.noPermission))
    if (hs.networkManagerHint) out.push(mk("equipnet.networkmanager", "NetworkManager", "warn", "NetworkManager puede quitar las direcciones del adaptador", hs.networkManagerHint))
    const warnings = netWarnings()
    if (warnings.length) out.push(mk("equipnet.overlap", "Redes repetidas en el servidor", warnings.some((w) => w.includes("arp_ignore")) ? "warn" : "info", warnings.join(" ")))
    if (driverId() === "manual") out.push(mk("equipnet.switch", "Switch de los equipos", "info", switchDetail.manual))
    else out.push(mk("equipnet.switch", "Switch de los equipos", swStatus.state === "ok" ? (swStatus.matches === false ? "warn" : "ok") : "fail",
      swStatus.state === "ok" ? `${swStatus.info.model ?? "Switch"} en ${x.switchHost ?? "?"}${swStatus.info.firmware ? ` (firmware ${swStatus.info.firmware})` : ""}${swStatus.matches === false ? `: ${swStatus.detail ?? ""}` : ""}` : swStatus.detail ?? "",
      swStatus.matches === false ? `${swStatus.drift.slice(0, 3).join("; ")}. Sistema › Red de equipos: «Configurar el switch»` : mgmtProblem))
    const eq = portsDTO().filter((p) => p.role === "equipment")
    const used = eq.filter((p) => p.usedBy.length)
    const up = eq.filter((p) => p.link === "up")
    out.push(mk("equipnet.ports", "Puertos del switch", used.some((p) => p.link === "down") ? "warn" : "info",
      `${up.length} de ${eq.length} con enlace; ${used.length} asignados${used.filter((p) => p.link === "down").length ? `; sin enlace: ${used.filter((p) => p.link === "down").map((p) => `${p.port} (${p.usedBy[0]?.equipmentName ?? ""})`).join(", ")}` : ""}`))
    return out
  }

  // --- public -----------------------------------------------------------------------------------------------------

  return {
    status: statusDTO,
    settings: settingsDTO,
    adapters: adaptersDTO,
    editContext(equipmentId) {
      const x = r()
      const ports = portsDTO(equipmentId).filter((p) => p.role === "equipment")
      const t = now().getTime()
      const recent = ports.filter((p) => p.link === "up" && p.linkUpAt && t - Date.parse(p.linkUpAt) < RECENT_LINK_MS && !p.usedBy.length)
        .sort((a, b) => Date.parse(b.linkUpAt ?? "") - Date.parse(a.linkUpAt ?? ""))
      return { configured: x.enabled && !!x.adapterMac, equipmentIp: x.equipmentIp, equipmentPort: deps.config.defaults.equipmentPort, portCount: x.portCount, uplinkPort: x.uplinkPort, ports, suggestedPort: recent[0]?.port ?? null }
    },
    route,
    onRoutesChanged(l) {
      listeners.add(l)
      return () => { listeners.delete(l) }
    },
    saveSettings,
    discover,
    chooseAdapter,
    cleanupLeftovers,
    async testSwitch(actor) {
      pollCount = 0
      await closeSession()
      await pollSwitch()
      deps.audit.record({ actor, action: "equipnet.discover", target: { type: "switch", name: r().switchHost ?? "-" }, detail: { test: true, state: swStatus.state } })
      return swStatus
    },
    async preview(kind) {
      return (await previewWith(kind)).dto
    },
    async apply(input, actor) {
      const pv = previews.get(input.planId)
      if (!pv || pv.dto.kind !== input.kind || Date.now() - pv.at > PREVIEW_TTL_MS) throw new DomainError("CONFLICT", switchJob.expired)
      if (pv.dto.blocked) throw new DomainError("VALIDATION", pv.dto.blocked)
      if (!pv.uplinkOk && !input.uplinkConfirmed) throw new DomainError("CONFIRMATION_REQUIRED", pv.dto.uplinkCheck.detail)
      if (pv.dto.nothingToDo) throw new DomainError("VALIDATION", switchJob.nothing)
      previews.delete(input.planId)
      return startJob(input.kind, pv, actor)
    },
    async previewPrepare(input) {
      const x = r()
      if (!x.adapterMac) throw new DomainError("VALIDATION", equipnetErrors.chooseFirst)
      const hostIp = detection?.host ?? x.switchHost
      if (!hostIp) throw new DomainError("VALIDATION", equipnetErrors.noDetection)
      const pw = input.password ?? password() ?? FACTORY.password
      return (await previewWith("apply", { host: hostIp, username: input.username ?? x.switchUsername ?? FACTORY.username, password: pw })).dto
    },
    async prepare(input, actor) {
      const d = detection
      const x = r()
      if (!x.adapterMac) throw new DomainError("VALIDATION", equipnetErrors.chooseFirst)
      const hostIp = d?.host ?? x.switchHost
      const mac = x.adapterMac
      if (!hostIp) throw new DomainError("VALIDATION", equipnetErrors.noDetection)
      const username = input.username ?? x.switchUsername ?? FACTORY.username
      const pw = input.password ?? password() ?? FACTORY.password
      const pv = await previewWith("apply", { host: hostIp, username, password: pw })
      if (pv.dto.blocked || (!pv.uplinkOk && !input.uplinkConfirmed)) return { started: false, preview: pv.dto, job: null, warnings: [] }
      // Consent given (the click, after the preview): save the settings, label the adapter, set up the server side
      // (on the chosen interface only) and the switch.
      const eqIp = x.equipmentIp
      if (!eqIp) throw new DomainError("VALIDATION", equipnetErrors.equipmentIpMissing)
      const saved = await saveSettings({
        ...settingsDTO(), equipmentIp: eqIp, enabled: true, driver: "tplink-easy-smart", switchHost: hostIp, switchUsername: username,
        switchPassword: pw, portCount: d?.portCount ?? x.portCount,
      }, actor)
      await ensureAdapterLabel(mac, actor)
      if (pv.dto.nothingToDo) {
        row = await deps.prisma.equipmentNetwork.update({ where: { id: "global" }, data: { appliedLayout: pv.target as unknown as object, appliedAt: now() } })
        detection = null
        schedulePublish()
        return { started: false, preview: pv.dto, job: null, warnings: saved.warnings }
      }
      detection = null
      return { started: true, preview: pv.dto, job: startJob("apply", pv, actor), warnings: saved.warnings }
    },
    async reconcileNow() {
      await scanAdapters()
      await reconcile("manual")
      return statusDTO()
    },
    manualInstructions(): ManualInstructionsDTO {
      const x = r()
      const p = plan()
      const t = targetLayout(p.ports, { portCount: x.portCount, uplinkPort: x.uplinkPort })
      return {
        rows: range(1, x.portCount).map((port) => {
          const m = portMembership(t, port)
          return { port, role: port === x.uplinkPort ? "uplink" : "equipment", pvid: t.pvids[port - 1] ?? 1, untagged: m.untagged, tagged: m.tagged }
        }),
        vlans: t.vlans.map((v) => ({ vid: v.vid, name: v.name, untagged: v.untagged, tagged: v.tagged })),
        notes: [],
      }
    },
    backupFile: backupPath,
    async reloadUsage() {
      await loadUsage()
      schedulePublish()
    },
    async reloadLabels() {
      await loadLabels()
      schedulePublish()
    },
    health,
    async start() {
      stopped = false
      await loadRow()
      await loadLabels()
      await loadUsage()
      await scanAdapters()
      await reconcile("arranque")
      void pollSwitch()
      const adapterMs = internals.adapterPollMs ?? cfg.serial.scanIntervalMs
      timers.push(setInterval(() => {
        void scanAdapters().then((changed) => {
          if (changed) {
            schedulePublish()
            void reconcile("adaptadores")
          }
        })
      }, adapterMs))
      timers.push(setInterval(() => { void reconcile("periódico") }, internals.reconcileMs ?? 15_000))
      timers.push(setInterval(() => { void pollSwitch() }, internals.switchPollMs ?? cfg.net.pollMs))
      for (const t of timers) t.unref()
      log.info("Red de equipos preparada", {
        activa: r().enabled, adaptador: r().adapterMac ?? "-", servidor: hostStatus.state, switch: r().switchHost ?? "-",
      })
    },
    async stop() {
      stopped = true
      for (const t of timers) clearInterval(t)
      timers = []
      if (publishTimer) clearTimeout(publishTimer)
      publishTimer = null
      if (reconciling) await Promise.race([reconciling, new Promise((res) => setTimeout(res, 2000).unref())])
      await closeSession()
      listeners.clear()
    },
  }
}
