// Network helpers for relay discovery (§4.10 "Interfaces"). Pure, given os.networkInterfaces() output.
import type os from "node:os"

export type OsInterfaces = NodeJS.Dict<os.NetworkInterfaceInfo[]>

export interface NetIface { name: string; address: string; prefix: number; network: string; broadcast: string }

const SKIP_IF = /^(lo|docker\d*|br-|veth|virbr|tailscale|zt|wg|tun|tap)/
export const FACTORY_SEEDS = ["192.168.0.123", "192.168.0.200"] as const
export const MAX_SCAN_HOSTS = 2048

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/
export const isIpv4 = (s: string): boolean => IPV4.test(s)

export function ipToInt(ip: string): number {
  return ip.split(".").reduce((a, o) => ((a << 8) | Number(o)) >>> 0, 0)
}
export function intToIp(n: number): string {
  return [24, 16, 8, 0].map((s) => (n >>> s) & 255).join(".")
}
const maskOf = (prefix: number): number => (prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0)

export function directedBroadcast(ip: string, prefix: number): string {
  return intToIp((ipToInt(ip) | ~maskOf(prefix)) >>> 0)
}

function isV4(a: os.NetworkInterfaceInfo): boolean {
  // Node 18.0-18.3 reported family as the number 4.
  return a.family === "IPv4" || (a.family as unknown) === 4
}
function prefixOf(a: os.NetworkInterfaceInfo): number | null {
  const p = a.cidr ? Number(a.cidr.split("/")[1]) : NaN
  return Number.isInteger(p) ? p : null
}

/** IPv4, not internal, prefix ≤ 30, and not a loopback/container/VPN interface name (D21). */
export function lanInterfaces(ifaces: OsInterfaces): NetIface[] {
  const out: NetIface[] = []
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (SKIP_IF.test(name)) continue
    for (const a of addrs ?? []) {
      const prefix = prefixOf(a)
      if (!isV4(a) || a.internal || prefix === null || prefix > 30) continue
      const ip = ipToInt(a.address)
      const mask = maskOf(prefix)
      out.push({ name, address: a.address, prefix, network: intToIp((ip & mask) >>> 0), broadcast: intToIp((ip | ~mask) >>> 0) })
    }
  }
  return out
}

/** Every IPv4 address of this host, internal ones included (skipped by scans). */
export function ownAddresses(ifaces: OsInterfaces): string[] {
  return Object.values(ifaces).flatMap((addrs) => (addrs ?? []).filter(isV4).map((a) => a.address))
}

/** The /24 of each LAN interface address, even when the interface prefix is shorter. */
export function defaultScanCidrs(lan: NetIface[]): string[] {
  return [...new Set(lan.map((i) => `${intToIp((ipToInt(i.address) & maskOf(24)) >>> 0)}/24`))]
}

export function parseCidr(c: string): { network: number; prefix: number } | null {
  const m = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(c.trim())
  if (!m || !isIpv4(m[1] ?? "")) return null
  const prefix = Number(m[2])
  if (prefix > 32) return null
  return { network: (ipToInt(m[1] ?? "") & maskOf(prefix)) >>> 0, prefix }
}

export function inCidr(ip: string, cidr: string): boolean {
  const c = parseCidr(cidr)
  if (!c || !isIpv4(ip)) return false
  return ((ipToInt(ip) & maskOf(c.prefix)) >>> 0) === c.network
}

/**
 * Hosts to scan: every CIDR must be /22 or narrower. Skips the network and broadcast addresses (except /31 and /32)
 * and our own IPs. The factory fallback IPs go first when inside a CIDR. At most `max` (2048) hosts.
 */
export function expandScanTargets(cidrs: string[], opts: { ownIps: readonly string[]; max?: number }): { hosts: string[]; truncated: boolean } {
  const max = opts.max ?? MAX_SCAN_HOSTS
  const own = new Set(opts.ownIps)
  const all: string[] = []
  const seen = new Set<string>()
  const add = (ip: string) => { if (!own.has(ip) && !seen.has(ip)) { seen.add(ip); all.push(ip) } }
  const parsed = cidrs.map((c) => {
    const p = parseCidr(c)
    if (!p || p.prefix < 22) throw new Error(`Red no válida o demasiado grande (usa /22 o más pequeña): ${c}`)
    return p
  })
  for (const seed of FACTORY_SEEDS) if (parsed.some((p) => ((ipToInt(seed) & maskOf(p.prefix)) >>> 0) === p.network)) add(seed)
  for (const p of parsed) {
    const size = 2 ** (32 - p.prefix)
    const first = p.prefix >= 31 ? p.network : p.network + 1
    const last = p.prefix >= 31 ? p.network + size - 1 : p.network + size - 2
    for (let n = first; n <= last; n++) add(intToIp(n >>> 0))
  }
  return { hosts: all.slice(0, max), truncated: all.length > max }
}

/** Networks implied by broadcast targets through their trailing 255 octets: 10.1.2.255 → 10.1.2.0/24. */
export function broadcastNetworks(targets: readonly string[]): string[] {
  const out: string[] = []
  for (const t of targets) {
    if (!isIpv4(t)) continue
    const o = t.split(".")
    let k = 4
    while (k > 0 && o[k - 1] === "255") k--
    if (k === 4 || k === 0) continue // no trailing 255, or 255.255.255.255: no network
    out.push(`${[...o.slice(0, k), ...new Array<string>(4 - k).fill("0")].join(".")}/${k * 8}`)
  }
  return out
}

/** Enrichment probes only go to IPs inside a LAN subnet or a broadcast-target network (§4.10 step 5). */
export function isEnrichable(ip: string, lan: readonly NetIface[], broadcastTargets: readonly string[] | null): boolean {
  if (!isIpv4(ip)) return false
  if (lan.some((i) => inCidr(ip, `${i.network}/${i.prefix}`))) return true
  return broadcastNetworks(broadcastTargets ?? []).some((c) => inCidr(ip, c))
}
