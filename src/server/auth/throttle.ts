import type { LoginThrottle } from "@/server/runtime/types"

// In-memory sliding windows (§6.3). The instance lives in the runtime (rt.throttle), never in Graph B module state.
const PAIR_LIMIT = 5
const PAIR_WINDOW_MS = 5 * 60_000
const PAIR_BLOCK_MS = 5 * 60_000
const IP_LIMIT = 20
const IP_WINDOW_MS = 5 * 60_000
const IP_BLOCK_MS = 15 * 60_000
const SETUP_IP_LIMIT = 10
const SETUP_GLOBAL_LIMIT = 30
const SETUP_WINDOW_MS = 10 * 60_000
const AUDIT_MIN_INTERVAL_MS = 60_000
const MAX_KEYS = 10_000

interface Entry { at: number; ticket: number }
interface Window { entries: Entry[]; blockedUntil: number; blockTicket: number | null }

export function createLoginThrottle(opts: { now?: () => number } = {}): LoginThrottle {
  const now = opts.now ?? Date.now
  const pairs = new Map<string, Window>()
  const ips = new Map<string, Window>()
  const setupByIp = new Map<string, number[]>()
  let setupGlobal: number[] = []
  const audited = new Map<string, number>()
  let nextTicket = 1

  const pairKey = (ip: string, username: string) => `${ip}\u0000${username}`

  function prune(map: Map<string, Window>, windowMs: number, t: number): void {
    if (map.size < MAX_KEYS) return
    for (const [k, w] of map) {
      w.entries = w.entries.filter((e) => t - e.at < windowMs)
      if (!w.entries.length && w.blockedUntil <= t) map.delete(k)
    }
  }
  function win(map: Map<string, Window>, key: string, windowMs: number, t: number): Window {
    let w = map.get(key)
    if (!w) { w = { entries: [], blockedUntil: 0, blockTicket: null }; map.set(key, w) }
    w.entries = w.entries.filter((e) => t - e.at < windowMs)
    return w
  }
  function recent(list: number[], t: number): number[] {
    return list.filter((at) => t - at < SETUP_WINDOW_MS)
  }

  return {
    begin(ip, username) {
      const t = now()
      prune(pairs, PAIR_WINDOW_MS, t)
      prune(ips, IP_WINDOW_MS, t)
      const p = win(pairs, pairKey(ip, username), PAIR_WINDOW_MS, t)
      const i = win(ips, ip, IP_WINDOW_MS, t)
      const until = Math.max(p.blockedUntil, i.blockedUntil)
      if (until > t) return { blocked: true, retryAfterSec: Math.ceil((until - t) / 1000) }
      // Record the attempt as a failure now, so parallel in-flight attempts count.
      const ticket = nextTicket++
      p.entries.push({ at: t, ticket })
      i.entries.push({ at: t, ticket })
      if (p.entries.length >= PAIR_LIMIT) { p.blockedUntil = t + PAIR_BLOCK_MS; p.blockTicket = ticket }
      if (i.entries.length >= IP_LIMIT) { i.blockedUntil = t + IP_BLOCK_MS; i.blockTicket = ticket }
      return { blocked: false, ticket }
    },

    success(ip, username, ticket) {
      pairs.delete(pairKey(ip, username))
      const i = ips.get(ip)
      if (!i) return
      i.entries = i.entries.filter((e) => e.ticket !== ticket)
      if (i.blockTicket === ticket) { i.blockedUntil = 0; i.blockTicket = null }
    },

    setupAttempt(ip) {
      const t = now()
      setupGlobal = recent(setupGlobal, t)
      const mine = recent(setupByIp.get(ip) ?? [], t)
      if (mine.length >= SETUP_IP_LIMIT || setupGlobal.length >= SETUP_GLOBAL_LIMIT) {
        setupByIp.set(ip, mine)
        return false
      }
      mine.push(t)
      setupGlobal.push(t)
      setupByIp.set(ip, mine)
      if (setupByIp.size > MAX_KEYS) for (const [k, v] of setupByIp) if (!recent(v, t).length) setupByIp.delete(k)
      return true
    },

    shouldAuditThrottled(ip, username) {
      const t = now()
      const key = pairKey(ip, username)
      const until = audited.get(key) ?? 0
      if (until > t) return false
      const p = pairs.get(key)
      const i = ips.get(ip)
      const blockEnd = Math.max(p?.blockedUntil ?? 0, i?.blockedUntil ?? 0)
      audited.set(key, blockEnd > t ? blockEnd : t + AUDIT_MIN_INTERVAL_MS)
      if (audited.size > MAX_KEYS) for (const [k, v] of audited) if (v <= t) audited.delete(k)
      return true
    },
  }
}
