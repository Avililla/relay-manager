"use client"

import * as React from "react"
import { clientId } from "@/lib/client/ids"

/**
 * Stable React keys for an editable list whose rows have no id yet (template slots, new rows). Operations go
 * through the returned helpers so keys follow their rows when rows are added, removed or moved. A list replaced
 * from outside with another length gets fresh keys.
 */
export function useRowIds(length: number) {
  const [ids, setIds] = React.useState<string[]>(() => Array.from({ length }, () => clientId("row")))
  let current = ids
  if (ids.length !== length) {
    current = Array.from({ length }, (_, i) => ids[i] ?? clientId("row"))
    setIds(current)
  }
  return {
    ids: current,
    add: () => setIds((l) => [...l, clientId("row")]),
    remove: (i: number) => setIds((l) => l.filter((_, j) => j !== i)),
    move: (i: number, d: -1 | 1) => setIds((l) => {
      const n = [...l]
      const j = i + d
      if (j < 0 || j >= n.length) return l
      ;[n[i], n[j]] = [n[j], n[i]]
      return n
    }),
  }
}

export function moveItem<T>(list: readonly T[], i: number, d: -1 | 1): T[] {
  const j = i + d
  if (j < 0 || j >= list.length) return [...list]
  const n = [...list]
  ;[n[i], n[j]] = [n[j], n[i]]
  return n
}

/** Uppercase key as typed: A–Z, 0–9 and "_" only (KeySchema). */
export function normalizeKey(v: string): string {
  return v.toUpperCase().replace(/[^A-Z0-9_]/g, "_").slice(0, 24)
}

/** First free "<PREFIX>_<n>" key. */
export function nextKey(prefix: string, taken: ReadonlyArray<string | null>): string {
  const set = new Set(taken.filter(Boolean))
  for (let n = 1; n < 100; n++) if (!set.has(`${prefix}_${n}`)) return `${prefix}_${n}`
  return `${prefix}_${Date.now() % 1000}`
}
