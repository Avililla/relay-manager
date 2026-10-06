// Port range and allocation for the accesses (pure; the server and the wizard preview use the same rules).

export interface PortRange { from: number; to: number }

/** At most this many ports in RM_ACCESS_PORTS (a typo like "3201-39000" must not make the server scan thousands). */
export const MAX_RANGE_SPAN = 1000

/** "3201-3230" or "3201". Unprivileged ports only (1024..65535), from ≤ to, at most 1000 ports. null when invalid. */
export function parsePortRange(raw: string): PortRange | null {
  const m = /^\s*(\d{1,5})\s*(?:-\s*(\d{1,5})\s*)?$/.exec(raw)
  if (!m) return null
  const from = Number(m[1])
  const to = m[2] === undefined ? from : Number(m[2])
  if (from < 1024 || to > 65535 || from > to || to - from + 1 > MAX_RANGE_SPAN) return null
  return { from, to }
}

export type PortIssue = "out-of-range" | "http-port" | "taken"

/** Why `port` cannot be used by an access (null = usable). `used` holds the ports of the other accesses. */
export function portIssue(port: number, opts: { range: PortRange; httpPort: number; used: ReadonlySet<number> }): PortIssue | null {
  if (port < opts.range.from || port > opts.range.to) return "out-of-range"
  if (port === opts.httpPort) return "http-port"
  if (opts.used.has(port)) return "taken"
  return null
}

export type AllocationResult = { ok: true; ports: number[] } | { ok: false; index: number }

/**
 * Fixed ports stay; every `null` gets the lowest free port of the range (never the web port, never a used or fixed one),
 * in row order. Deterministic: the wizard shows the same preview the server will give.
 */
export function allocatePorts(requested: ReadonlyArray<number | null>, opts: { range: PortRange; httpPort: number; used: Iterable<number> }): AllocationResult {
  const taken = new Set<number>(opts.used)
  taken.add(opts.httpPort)
  for (const p of requested) if (p !== null) taken.add(p)
  const out: number[] = []
  let next = opts.range.from
  for (const [i, p] of requested.entries()) {
    if (p !== null) {
      out.push(p)
      continue
    }
    while (next <= opts.range.to && taken.has(next)) next++
    if (next > opts.range.to) return { ok: false, index: i }
    out.push(next)
    taken.add(next)
  }
  return { ok: true, ports: out }
}
