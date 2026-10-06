// The known-boards map (§4.10): one in-memory map for passive, active and scan results. Keyed by MAC, otherwise
// "ip:httpPort"; at most 256 entries (oldest lastSeenAt evicted); `relay.discovered` rate-limited per key.
// Cross-referenced with DB boards (MAC, then host) at read time; an announcement never changes the DB (D22).
import type { DetectResultDTO, DiscoveredBoardDTO, DiscoverySource } from "@/lib/contracts/relays"
import type { KnownBoardRef } from "../controller"

export interface KnownUpdate {
  ip: string
  mac?: string | null
  hostname?: string | null
  model?: string | null
  moduleId?: number | null
  tcpPort?: number | null
  httpPort?: number | null
  /** undefined = keep; null = nothing detected this time (the previous detect is kept). */
  detect?: DetectResultDTO | null
  reachable?: boolean
  hints?: string[]
}

interface Entry {
  key: string
  sources: Set<DiscoverySource>
  firstSeenAt: Date
  lastSeenAt: Date
  ip: string
  mac: string | null
  hostname: string | null
  model: string | null
  moduleId: number | null
  tcpPort: number | null
  httpPort: number | null
  detect: DetectResultDTO | null
  reachable: boolean
  hints: string[]
  lastPublishAt: number
  signature: string
}

export interface KnownBoards {
  upsert(u: KnownUpdate, source: DiscoverySource): DiscoveredBoardDTO
  list(): DiscoveredBoardDTO[]
  find(key: string): DiscoveredBoardDTO | null
  size(): number
}

const SOURCE_ORDER: DiscoverySource[] = ["udp-passive", "udp-active", "scan"]

/**
 * The newer detect wins, except for identity fields it did not learn: a subnet scan (no UDP announcement) must not
 * blank the firmware or hostname an earlier UDP search found.
 */
function mergeDetect(prev: DetectResultDTO | null, next: DetectResultDTO): DetectResultDTO {
  if (!prev) return next
  return {
    ...next,
    model: next.model ?? prev.model,
    moduleId: next.moduleId ?? prev.moduleId,
    relayCount: next.relayCount ?? prev.relayCount,
    hostname: next.hostname ?? prev.hostname,
    mac: next.mac ?? prev.mac,
    firmware: next.firmware ?? prev.firmware,
  }
}
const MAX_HINTS = 8

export function createKnownBoards(opts: {
  now: () => Date
  boards: () => KnownBoardRef[]
  publish: (board: DiscoveredBoardDTO) => void
  max?: number
  publishMinIntervalMs?: number
}): KnownBoards {
  const max = opts.max ?? 256
  const minInterval = opts.publishMinIntervalMs ?? 5000
  const map = new Map<string, Entry>()

  function crossRef(e: Entry, boards: KnownBoardRef[]): Pick<DiscoveredBoardDTO, "registeredBoardId" | "registeredBoardName" | "ipChanged"> {
    const byMac = e.mac ? boards.find((b) => b.mac === e.mac) : undefined
    if (byMac) return { registeredBoardId: byMac.id, registeredBoardName: byMac.name, ipChanged: byMac.host !== e.ip }
    const byHost = boards.find((b) => b.host === e.ip && (e.httpPort === null || b.httpPort === e.httpPort))
    if (byHost) return { registeredBoardId: byHost.id, registeredBoardName: byHost.name, ipChanged: false }
    return { registeredBoardId: null, registeredBoardName: null, ipChanged: false }
  }

  function toDTO(e: Entry, boards: KnownBoardRef[] = opts.boards()): DiscoveredBoardDTO {
    return {
      key: e.key,
      sources: SOURCE_ORDER.filter((s) => e.sources.has(s)),
      firstSeenAt: e.firstSeenAt.toISOString(),
      lastSeenAt: e.lastSeenAt.toISOString(),
      ip: e.ip, mac: e.mac, hostname: e.hostname, model: e.model, moduleId: e.moduleId, tcpPort: e.tcpPort, httpPort: e.httpPort,
      detect: e.detect,
      ...crossRef(e, boards),
      reachable: e.reachable,
      hints: [...e.hints],
    }
  }

  function signatureOf(d: DiscoveredBoardDTO): string {
    const { firstSeenAt: _f, lastSeenAt: _l, ...rest } = d
    void _f
    void _l
    return JSON.stringify(rest)
  }

  function findExisting(u: KnownUpdate): Entry | undefined {
    if (u.mac) {
      const direct = map.get(u.mac)
      if (direct) return direct
    } else {
      const key = `${u.ip}:${u.httpPort ?? 80}`
      const direct = map.get(key)
      if (direct) return direct
      // A MAC entry at the same IP (passive/active) absorbs a scan result.
      for (const e of map.values()) if (e.mac && e.ip === u.ip && (e.httpPort === null || u.httpPort == null || e.httpPort === u.httpPort)) return e
    }
    return undefined
  }

  function mergeInto(target: Entry, u: KnownUpdate): void {
    target.ip = u.ip
    if (u.mac) target.mac = u.mac
    if (u.hostname) target.hostname = u.hostname
    if (u.model) target.model = u.model
    if (u.moduleId != null) target.moduleId = u.moduleId
    if (u.tcpPort != null) target.tcpPort = u.tcpPort
    if (u.httpPort != null) target.httpPort = u.httpPort
    if (u.detect) target.detect = mergeDetect(target.detect, u.detect)
    if (u.reachable !== undefined) target.reachable = u.reachable
    for (const h of u.hints ?? []) if (!target.hints.includes(h) && target.hints.length < MAX_HINTS) target.hints.push(h)
  }

  function evict(): void {
    while (map.size > max) {
      let oldest: Entry | null = null
      for (const e of map.values()) if (!oldest || e.lastSeenAt < oldest.lastSeenAt) oldest = e
      if (!oldest) return
      map.delete(oldest.key)
    }
  }

  return {
    upsert(u, source) {
      const now = opts.now()
      let e = findExisting(u)
      const isNew = !e
      if (!e) {
        const key = u.mac ?? `${u.ip}:${u.httpPort ?? 80}`
        e = {
          key, sources: new Set(), firstSeenAt: now, lastSeenAt: now, ip: u.ip, mac: null, hostname: null, model: null,
          moduleId: null, tcpPort: null, httpPort: null, detect: null, reachable: false, hints: [], lastPublishAt: 0, signature: "",
        }
        map.set(key, e)
      }
      // A MAC arriving for an entry keyed by address: absorb the address entries of that IP into the MAC key.
      if (u.mac && e.key !== u.mac) {
        map.delete(e.key)
        e.key = u.mac
        map.set(u.mac, e)
      }
      if (u.mac) {
        for (const other of [...map.values()]) {
          if (other === e || other.mac || other.ip !== u.ip) continue
          for (const s of other.sources) e.sources.add(s)
          if (other.firstSeenAt < e.firstSeenAt) e.firstSeenAt = other.firstSeenAt
          if (!e.detect && other.detect) e.detect = other.detect
          if (e.httpPort === null && other.httpPort !== null) e.httpPort = other.httpPort
          if (other.reachable) e.reachable = true
          map.delete(other.key)
        }
      }
      mergeInto(e, u)
      e.sources.add(source)
      e.lastSeenAt = now
      evict()
      const dto = toDTO(e)
      const sig = signatureOf(dto)
      if (map.has(e.key) && (isNew || sig !== e.signature || now.getTime() - e.lastPublishAt >= minInterval)) {
        e.signature = sig
        e.lastPublishAt = now.getTime()
        opts.publish(dto)
      }
      return dto
    },
    list() {
      const boards = opts.boards()
      return [...map.values()].sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime()).map((e) => toDTO(e, boards))
    },
    find(key) {
      const e = map.get(key) ?? [...map.values()].find((x) => `${x.ip}:${x.httpPort ?? 80}` === key)
      return e ? toDTO(e) : null
    },
    size: () => map.size,
  }
}
