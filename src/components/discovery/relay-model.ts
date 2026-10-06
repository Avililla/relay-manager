// Descubrimiento > Placas de relés (§8.9): pure view logic over the known-boards map and the scan dialog.
import { CidrSchema, PortSchema, type DiscoveredBoardDTO } from "@/lib/contracts/relays"
import { RELAY_TEXT } from "@/lib/i18n/relays"
import { modelRelayCount } from "@/lib/relays/models"

export type DiscoveredState = "new" | "registered" | "ip-changed" | "unreachable"

/** Hints worth a line under the board: the informational "OUI Microchip" (true of every Devantech board) is dropped. */
export function actionHints(hints: readonly string[]): string[] {
  return hints.filter((h) => h !== RELAY_TEXT.hintMicrochip)
}

/** "Nueva" / "Registrada: <nombre>" / "IP cambiada" (D22) / "No alcanzable". */
export function discoveredState(b: DiscoveredBoardDTO): DiscoveredState {
  if (b.registeredBoardId) return b.ipChanged ? "ip-changed" : "registered"
  return b.reachable ? "new" : "unreachable"
}

const ipKey = (ip: string): number => ip.split(".").reduce((a, o) => a * 256 + (Number(o) || 0), 0)

/** Stable order: by IP, then by key. */
export function sortDiscovered(list: readonly DiscoveredBoardDTO[]): DiscoveredBoardDTO[] {
  return [...list].sort((a, b) => ipKey(a.ip) - ipKey(b.ip) || a.key.localeCompare(b.key))
}

/** Merges one `relay.discovered` event into the list (same key → replaced). */
export function upsertDiscovered(list: readonly DiscoveredBoardDTO[], board: DiscoveredBoardDTO): DiscoveredBoardDTO[] {
  const i = list.findIndex((b) => b.key === board.key)
  if (i >= 0 && list[i] === board) return list as DiscoveredBoardDTO[]
  return sortDiscovered(i >= 0 ? list.map((b, j) => (j === i ? board : b)) : [...list, board])
}

export function discoveredModel(b: DiscoveredBoardDTO): string | null {
  return b.detect?.model ?? b.model
}

export function discoveredHttpPort(b: DiscoveredBoardDTO): number | null {
  return b.httpPort ?? b.detect?.httpPort ?? null
}

/** "192.168.1.40:80" (or just the IP when the HTTP port is unknown). */
export function discoveredAddress(b: DiscoveredBoardDTO): string {
  const port = discoveredHttpPort(b)
  return port ? `${b.ip}:${port}` : b.ip
}

/** Physical relays from the detect result, else from the model table (D4). */
export function discoveredRelayCount(b: DiscoveredBoardDTO): number | null {
  return b.detect?.relayCount ?? modelRelayCount(discoveredModel(b))
}

export function discoveredMac(b: DiscoveredBoardDTO): string | null {
  return b.mac ?? b.detect?.mac ?? null
}

/** Counts by state (for the tab summary). */
export function discoveredCounts(list: readonly DiscoveredBoardDTO[]): Record<DiscoveredState, number> {
  const c: Record<DiscoveredState, number> = { new: 0, registered: 0, "ip-changed": 0, unreachable: 0 }
  for (const b of list) c[discoveredState(b)]++
  return c
}

// Scan dialog --------------------------------------------------------------------------------------------------

export const MAX_SCAN_CIDRS = 8
export const MAX_SCAN_HOSTS = 2048

/** One CIDR per line (commas and spaces also separate). Returns the valid ones and the invalid entries. */
export function parseCidrList(text: string): { cidrs: string[]; invalid: string[] } {
  const items = [...new Set(text.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean))]
  const cidrs: string[] = []
  const invalid: string[] = []
  for (const c of items) {
    const ok = CidrSchema.safeParse(c).success && c.split("/")[0]!.split(".").every((o) => Number(o) <= 255)
    ;(ok ? cidrs : invalid).push(c)
  }
  return { cidrs, invalid }
}

/** "80, 8080" → [80, 8080]; null when any entry is not a port or there are not 1 to 4. */
export function parsePortList(text: string): number[] | null {
  const items = text.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean)
  if (items.length < 1 || items.length > 4) return null
  const ports = items.map((s) => (/^\d+$/.test(s) ? Number(s) : NaN))
  if (ports.some((p) => !PortSchema.safeParse(p).success)) return null
  return [...new Set(ports)]
}

/** Upper bound of the probed hosts (network and broadcast skipped), capped like the server (2048). */
export function scanHostEstimate(cidrs: readonly string[]): number {
  let n = 0
  for (const c of cidrs) {
    const prefix = Number(c.split("/")[1])
    if (!Number.isInteger(prefix)) continue
    const size = 2 ** (32 - prefix)
    n += prefix >= 31 ? size : size - 2
  }
  return Math.min(n, MAX_SCAN_HOSTS)
}

export interface ScanForm { cidrs: string; ports: string }
export type CidrProblem = { kind: "empty" } | { kind: "invalid"; value: string } | { kind: "too-many" }
export type ScanInputResult =
  | { ok: true; cidrs: string[]; ports: number[] }
  | { ok: false; cidrs: CidrProblem | null; ports: boolean }

/** Validates the scan dialog: the action input, or which fields are wrong (the Spanish copy is the caller's). */
export function scanInput(form: ScanForm): ScanInputResult {
  const { cidrs, invalid } = parseCidrList(form.cidrs)
  const ports = parsePortList(form.ports)
  const cidrProblem: CidrProblem | null = invalid.length ? { kind: "invalid", value: invalid[0]! }
    : !cidrs.length ? { kind: "empty" }
      : cidrs.length > MAX_SCAN_CIDRS ? { kind: "too-many" } : null
  if (cidrProblem || !ports) return { ok: false, cidrs: cidrProblem, ports: !ports }
  return { ok: true, cidrs, ports }
}

export interface IfaceInfo { address: string; family: string | number; internal: boolean; cidr?: string | null }
const SKIP_IF = /^(lo|docker\d*|br-|veth|virbr|tailscale|zt|wg|tun|tap)/

/**
 * The scan dialog default when RM_RELAY_SCAN_CIDRS is not set: the /24 of each LAN interface (same rule as the
 * server, §4.10 / D21). Input is `os.networkInterfaces()` output.
 */
export function defaultScanCidrs(ifaces: Record<string, IfaceInfo[] | undefined>): string[] {
  const out: string[] = []
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (SKIP_IF.test(name)) continue
    for (const a of addrs ?? []) {
      const v4 = a.family === "IPv4" || a.family === 4
      const prefix = a.cidr ? Number(a.cidr.split("/")[1]) : NaN
      if (!v4 || a.internal || !Number.isInteger(prefix) || prefix > 30) continue
      const o = a.address.split(".")
      out.push(`${o[0]}.${o[1]}.${o[2]}.0/24`)
    }
  }
  return [...new Set(out)]
}
