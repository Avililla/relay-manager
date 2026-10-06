// "Ordenar según nombre de host" (§8.9 wizard step 3, W2-B). Pure; unit-tested in hostname-order.test.ts.

export interface HostnameSlot { hostnameRegex?: string | null }
export interface HostnameOrderResult {
  /** stableKey per slot (same length as the input), or null for an unassigned slot. */
  assignments: Array<string | null>
  /** Slots whose `hostnameRegex` matched an identified port. */
  matched: number
  /** True when `assignments` differs from `current`. */
  changed: boolean
}

function compile(src: string | null | undefined): RegExp | null {
  if (!src) return null
  try {
    return new RegExp(src, "i")
  } catch {
    return null
  }
}

/**
 * Reorders console-to-port assignments using the hostnames found by "Identificar".
 *
 * - `current[i]` is the stableKey assigned to slot i (or null); `hostnames` maps identified stableKeys to the
 *   hostname the probe read (or null). Candidate ports are the current ports (slot order) followed by the other
 *   identified ports (insertion order), so a port that "Asignar en orden" left out can still be pulled in.
 * - Each slot with a valid `hostnameRegex` (case-insensitive) takes the first free candidate whose hostname
 *   matches. The most constrained slots (fewest candidates) choose first, so a hostname that matches two
 *   patterns goes to the slot that has no other option.
 * - A slot without a match keeps its port when no matched slot took it; otherwise it receives the next port
 *   that was displaced, in the old slot order. No port is ever assigned twice.
 *
 * Returns null when no slot matched anything: there is nothing to offer.
 */
export function reorderByHostname(
  slots: ReadonlyArray<HostnameSlot>,
  current: ReadonlyArray<string | null>,
  hostnames: Readonly<Record<string, string | null | undefined>>,
): HostnameOrderResult | null {
  const candidates: string[] = []
  const seen = new Set<string>()
  for (const k of [...current, ...Object.keys(hostnames)]) {
    if (k && !seen.has(k)) {
      seen.add(k)
      candidates.push(k)
    }
  }

  const options = slots.map((s) => {
    const re = compile(s.hostnameRegex)
    if (!re) return [] as string[]
    return candidates.filter((k) => {
      const h = hostnames[k]
      return !!h && re.test(h)
    })
  })

  const order = slots.map((_, i) => i).filter((i) => options[i].length > 0)
  if (!order.length) return null
  order.sort((a, b) => options[a].length - options[b].length || a - b)

  const result: Array<string | null> = slots.map(() => null)
  const taken = new Set<string>()
  const matchedSlots = new Set<number>()
  for (const i of order) {
    const pick = options[i].find((k) => !taken.has(k))
    if (pick) {
      result[i] = pick
      taken.add(pick)
      matchedSlots.add(i)
    }
  }
  if (!matchedSlots.size) return null

  const unmatched = slots.map((_, i) => i).filter((i) => !matchedSlots.has(i))
  const needPort: number[] = []
  for (const i of unmatched) {
    const k = current[i] ?? null
    if (k && !taken.has(k)) {
      result[i] = k
      taken.add(k)
    } else if (k) {
      needPort.push(i)
    }
  }
  const displaced = current.filter((k): k is string => !!k && !taken.has(k))
  for (const i of needPort) {
    const k = displaced.shift()
    if (!k) break
    result[i] = k
    taken.add(k)
  }

  const changed = result.some((k, i) => k !== (current[i] ?? null))
  return { assignments: result, matched: matchedSlots.size, changed }
}
