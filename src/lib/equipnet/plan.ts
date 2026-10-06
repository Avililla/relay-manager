// The address and VLAN plan of "Red de equipos" (pure; shared by server and UI):
// - switch port n (every port but the uplink) is VLAN vlanBase + n; the server reaches it through the VLAN interface
//   rmv<vid> with its own address (normally <equipment subnet> + hostOffset + n; never the equipment IP and never an
//   address the server already has on another interface), and a policy rule "from <that address> lookup <table
//   20000 + vid>" whose table only has "<equipment subnet> dev rmv<vid>" and "unreachable default" (fail closed);
// - the management address (untagged, on the chosen adapter itself) gets the same treatment with table 20000.
// Nothing goes to the main routing table, so the rest of the server's traffic is never affected, even when another
// interface of the server is on the same subnet (and even reaches another host with the equipment IP there).
import { formatIPv4, maskOf, overlaps, parseCidr, parseIPv4, subnetOf } from "./ipv4"

/** Routing tables reserved for the app: 20000 (management) and 20000 + VLAN id. */
export const MGMT_TABLE = 20000
export const TABLE_MAX = 20000 + 4094
/**
 * Rule preferences: 1000 (management) and 1000 + VLAN id (1002..5094). They sort before the main table (32766) and
 * before the rules other software usually adds (Tailscale 5210..5270, wg-quick and NetworkManager auto-numbered just
 * below the first existing rule, 32765…). Each rule only matches packets whose source is one of the app's own
 * addresses, so sorting early never affects any other traffic. The reconcile loop still verifies every VLAN with
 * `ip route get <equipo> from <dirección>` (a rule added later with a lower preference would show up there).
 */
export const PREF_BASE = 1000
export const PREF_MAX = PREF_BASE + 4094
/** Preferences used by versions before 2026-09 (pref = table): recognised as the app's own and moved. */
export const LEGACY_PREF_MIN = MGMT_TABLE
export const LEGACY_PREF_MAX = TABLE_MAX
export const VLAN_IF_PREFIX = "rmv"
export const VLAN_IF_RE = /^rmv(\d{1,4})$/
/** The rule preference of one of the app's tables. */
export const prefOfTable = (table: number): number => PREF_BASE + (table - MGMT_TABLE)

export interface EquipnetPlanInput {
  portCount: number
  uplinkPort: number
  vlanBase: number
  mgmtAddress: string
  /** The IP every equipment has; null until an admin (or the profile: RM_EQUIPNET_EQUIPMENT_IP) sets it. */
  equipmentIp: string | null
  equipmentPrefix: number
  hostOffset: number
}

/** A typical layout (tests and tools; the app's values live in the database, without an equipment IP until set). */
export const DEFAULT_EQUIPNET: EquipnetPlanInput = {
  portCount: 8, uplinkPort: 1, vlanBase: 100, mgmtAddress: "192.168.0.250/24",
  equipmentIp: "192.168.1.10", equipmentPrefix: 24, hostOffset: 200,
}

export interface PortPlan { port: number; vid: number; ifname: string; hostAddress: string; table: number; pref: number }
export interface MgmtPlan { address: string; prefix: number; subnet: string; table: number; pref: number }
export interface EquipnetPlan {
  ports: PortPlan[]
  mgmt: MgmtPlan | null
  subnet: string
  prefix: number
  equipmentIp: string | null
  /** Field errors (Spanish) keyed by settings field. */
  errors: Record<string, string[]>
}

export const vlanIfname = (vid: number): string => `${VLAN_IF_PREFIX}${vid}`
export const portForVid = (plan: EquipnetPlan, vid: number): PortPlan | undefined => plan.ports.find((p) => p.vid === vid)

export interface PlanOptions {
  /**
   * Addresses the server already has on other interfaces (never rmv*): no VLAN gets one of them. A port whose usual
   * address (network + offset + port) is taken gets the next free one after the last port's.
   */
  avoid?: readonly string[]
}

export function planEquipnet(s: EquipnetPlanInput, o: PlanOptions = {}): EquipnetPlan {
  const errors: Record<string, string[]> = {}
  const add = (k: string, m: string) => { (errors[k] ??= []).push(m) }
  const eqIp = s.equipmentIp === null ? null : parseIPv4(s.equipmentIp)
  const prefix = s.equipmentPrefix
  const subnet = eqIp === null || s.equipmentIp === null ? "0.0.0.0/0" : subnetOf(s.equipmentIp, prefix)
  const mask = maskOf(prefix)
  const network = eqIp === null ? 0 : (eqIp & mask) >>> 0
  const broadcast = (network | ~mask) >>> 0
  if (s.equipmentIp === null) add("equipmentIp", "Indica la IP de los equipos")
  else if (eqIp === null) add("equipmentIp", "Dirección IPv4 no válida")
  else if (eqIp === network || eqIp === broadcast) add("equipmentIp", `${s.equipmentIp} es la dirección de red o de difusión de ${subnet}`)
  if (s.uplinkPort < 1 || s.uplinkPort > s.portCount) add("uplinkPort", `Elige un puerto entre 1 y ${s.portCount}`)

  const ports: PortPlan[] = []
  const avoid = new Set((o.avoid ?? []).map((a) => parseIPv4(a)).filter((n): n is number => n !== null))
  const taken = new Set<number>()
  const spill: Array<{ port: number; vid: number }> = []
  let spillFrom = network + s.hostOffset + s.portCount + 1
  const free = (n: number) => n > network && n < broadcast && n !== eqIp && !avoid.has(n) && !taken.has(n)
  // Without the equipment IP there is no subnet: no VLAN addresses at all.
  for (let port = 1; eqIp !== null && port <= s.portCount; port++) {
    if (port === s.uplinkPort) continue
    const vid = s.vlanBase + port
    if (vid < 2 || vid > 4094) {
      add("vlanBase", `La VLAN del puerto ${port} sería ${vid}: tiene que estar entre 2 y 4094`)
      break
    }
    const host = network + s.hostOffset + port
    const hostAddress = formatIPv4(host >>> 0)
    if (eqIp !== null) {
      if (host >= broadcast || host > 0xffffffff) {
        add("hostOffset", `La dirección del servidor para el puerto ${port} queda fuera de la red ${subnet} o es la de difusión: usa un desplazamiento menor`)
        break
      }
      if (host === eqIp) {
        add("hostOffset", `La dirección del servidor para el puerto ${port} sería ${hostAddress}, la de los equipos: cambia el desplazamiento`)
        break
      }
    }
    if (avoid.has(host)) {
      spill.push({ port, vid })
      ports.push({ port, vid, ifname: vlanIfname(vid), hostAddress: "", table: MGMT_TABLE + vid, pref: prefOfTable(MGMT_TABLE + vid) })
      continue
    }
    taken.add(host)
    ports.push({ port, vid, ifname: vlanIfname(vid), hostAddress, table: MGMT_TABLE + vid, pref: prefOfTable(MGMT_TABLE + vid) })
  }
  // Ports whose usual address the server already has elsewhere: the next free addresses after the last port's.
  for (const x of spill) {
    while (spillFrom < broadcast && !free(spillFrom)) spillFrom++
    const pp = ports.find((q) => q.port === x.port)
    if (!pp) continue
    if (spillFrom >= broadcast) {
      add("hostOffset", `No queda ninguna dirección libre en ${subnet} para el puerto ${x.port}: usa un desplazamiento menor`)
      break
    }
    pp.hostAddress = formatIPv4(spillFrom >>> 0)
    taken.add(spillFrom)
    spillFrom++
  }

  const m = parseCidr(s.mgmtAddress)
  let mgmt: MgmtPlan | null = null
  if (!m) add("mgmtAddress", "Usa una dirección con prefijo (p. ej. 192.168.0.250/24)")
  else if (m.prefix < 8 || m.prefix > 30) add("mgmtAddress", "El prefijo tiene que estar entre 8 y 30")
  else if (m.ip === m.network || m.ip === m.broadcast) add("mgmtAddress", `${m.ip} es la dirección de red o de difusión`)
  else if (eqIp !== null && overlaps(`${m.network}/${m.prefix}`, subnet)) add("mgmtAddress", `La gestión del switch y los equipos no pueden estar en la misma red (${subnet})`)
  else mgmt = { address: m.ip, prefix: m.prefix, subnet: `${m.network}/${m.prefix}`, table: MGMT_TABLE, pref: PREF_BASE }

  return { ports: ports.filter((p) => p.hostAddress !== ""), mgmt, subnet, prefix, equipmentIp: s.equipmentIp, errors }
}
