// IPv4 helpers for "Red de equipos" (pure; shared by server and UI). Addresses are unsigned 32-bit numbers.

const OCTET = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/

export function parseIPv4(s: string): number | null {
  const parts = s.split(".")
  if (parts.length !== 4 || !parts.every((p) => OCTET.test(p))) return null
  return parts.reduce((acc, p) => ((acc << 8) | Number(p)) >>> 0, 0)
}

export const isIPv4 = (s: string): boolean => parseIPv4(s) !== null

export function formatIPv4(n: number): string {
  return [24, 16, 8, 0].map((sh) => (n >>> sh) & 0xff).join(".")
}

export function maskOf(prefix: number): number {
  return prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
}

export interface Cidr { ip: string; prefix: number; network: string; broadcast: string }

/** "192.168.0.250/24" → address, prefix, network and broadcast; null when invalid. */
export function parseCidr(s: string): Cidr | null {
  const m = /^([^/]+)\/(\d{1,2})$/.exec(s.trim())
  if (!m) return null
  const ip = parseIPv4(m[1])
  const prefix = Number(m[2])
  if (ip === null || prefix < 0 || prefix > 32) return null
  const mask = maskOf(prefix)
  return { ip: formatIPv4(ip), prefix, network: formatIPv4((ip & mask) >>> 0), broadcast: formatIPv4((ip | ~mask) >>> 0) }
}

/** "192.168.1.10", 24 → "192.168.1.0/24". */
export function subnetOf(ip: string, prefix: number): string {
  const n = parseIPv4(ip) ?? 0
  return `${formatIPv4((n & maskOf(prefix)) >>> 0)}/${prefix}`
}

export function inSubnet(ip: string, subnet: string): boolean {
  const c = parseCidr(subnet)
  const n = parseIPv4(ip)
  if (!c || n === null) return false
  const mask = maskOf(c.prefix)
  return ((n & mask) >>> 0) === ((parseIPv4(c.network) ?? 0) & mask) >>> 0
}

/** Do two subnets share any address? */
export function overlaps(a: string, b: string): boolean {
  const x = parseCidr(a)
  const y = parseCidr(b)
  if (!x || !y) return false
  const p = Math.min(x.prefix, y.prefix)
  const mask = maskOf(p)
  return (((parseIPv4(x.network) ?? 0) & mask) >>> 0) === (((parseIPv4(y.network) ?? 0) & mask) >>> 0)
}
