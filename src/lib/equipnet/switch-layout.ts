// 802.1Q layout of the equipment switch and the ordered, lockout-safe list of changes to reach it (pure; shared).
//
// Target: the uplink port (wired to this server) stays an untagged member of VLAN 1 with PVID 1, so the switch
// management is always reachable untagged from the server; it is a tagged member of every equipment VLAN. Each
// equipment port n is an untagged member of VLAN vlanBase + n only, with that PVID (and, when the firmware allows it,
// out of VLAN 1), so the equipment cannot see each other nor the management.
//
// Order (never locks the server out of the management): enable 802.1Q → add memberships (every VLAN gets the union
// of what it has and what it will have) → PVIDs → final memberships (removals, VLAN 1 last) → delete old VLANs → save.
import type { PortPlan } from "./plan"

export interface Dot1qVlan { vid: number; name: string; untagged: number[]; tagged: number[] }
export interface Dot1qState {
  enabled: boolean
  portCount: number
  vlans: Dot1qVlan[]
  /** PVID of port n at index n - 1. */
  pvids: number[]
}

export type SwitchOp =
  | { op: "enable"; on: boolean }
  | { op: "vlan"; vlan: Dot1qVlan; phase: "add" | "final"; existed: boolean }
  | { op: "pvid"; ports: number[]; pvid: number }
  | { op: "delete"; vids: number[] }
  | { op: "save" }

const sorted = (xs: readonly number[]) => [...new Set(xs)].sort((a, b) => a - b)
export const range = (from: number, to: number): number[] => Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => from + i)

export function normalizeVlan(v: Dot1qVlan): Dot1qVlan {
  const tagged = sorted(v.tagged)
  return { vid: v.vid, name: v.name, tagged, untagged: sorted(v.untagged).filter((p) => !tagged.includes(p)) }
}

export function sameMembers(a: Dot1qVlan, b: Dot1qVlan): boolean {
  const x = normalizeVlan(a)
  const y = normalizeVlan(b)
  return x.untagged.join(",") === y.untagged.join(",") && x.tagged.join(",") === y.tagged.join(",")
}

/** What 802.1Q looks like right after enabling it: VLAN 1 with every port untagged, every PVID 1. */
export function freshDot1q(portCount: number): Dot1qState {
  return { enabled: true, portCount, vlans: [{ vid: 1, name: "Default", untagged: range(1, portCount), tagged: [] }], pvids: range(1, portCount).map(() => 1) }
}

export function vlanName(vid: number): string {
  return `rmv${vid}`
}

/** The layout the app sets up. `pruneVlan1: false` keeps every port in VLAN 1 (firmware that does not allow it). */
export function targetLayout(ports: readonly PortPlan[], o: { portCount: number; uplinkPort: number; pruneVlan1?: boolean }): Dot1qState {
  const all = range(1, o.portCount)
  const vlans: Dot1qVlan[] = [{ vid: 1, name: "Default", untagged: o.pruneVlan1 === false ? all : [o.uplinkPort], tagged: [] }]
  const pvids = all.map(() => 1)
  for (const p of ports) {
    vlans.push({ vid: p.vid, name: vlanName(p.vid), untagged: [p.port], tagged: [o.uplinkPort] })
    pvids[p.port - 1] = p.vid
  }
  return { enabled: true, portCount: o.portCount, vlans, pvids }
}

/** Would the server still reach the management (untagged VLAN 1 on the uplink, PVID 1)? */
export function keepsManagement(s: Dot1qState, uplinkPort: number): boolean {
  if (!s.enabled) return true
  const v1 = s.vlans.find((v) => v.vid === 1)
  return !!v1 && v1.untagged.includes(uplinkPort) && !v1.tagged.includes(uplinkPort) && s.pvids[uplinkPort - 1] === 1
}

function union(cur: Dot1qVlan | undefined, target: Dot1qVlan): Dot1qVlan {
  if (!cur) return normalizeVlan(target)
  const tagged = new Set(target.tagged)
  const untagged = new Set(target.untagged)
  for (const p of cur.tagged) if (!untagged.has(p)) tagged.add(p)
  for (const p of cur.untagged) if (!tagged.has(p)) untagged.add(p)
  return normalizeVlan({ vid: target.vid, name: target.name || cur.name, untagged: [...untagged], tagged: [...tagged] })
}

/**
 * The ordered operations from `current` to `target`. With `target.enabled === false`: disable 802.1Q (back to a flat
 * switch). A non-empty list always ends with "save" (the switch keeps changes in RAM until saved to flash).
 */
export function planSwitchOps(current: Dot1qState, target: Dot1qState): SwitchOp[] {
  if (!target.enabled) return current.enabled ? [{ op: "enable", on: false }, { op: "save" }] : []
  const ops: SwitchOp[] = []
  let cur = current
  if (!cur.enabled) {
    ops.push({ op: "enable", on: true })
    cur = freshDot1q(target.portCount)
  }
  const find = (s: Dot1qState, vid: number) => s.vlans.find((v) => v.vid === vid)
  const byVid = new Map(cur.vlans.map((v) => [v.vid, normalizeVlan(v)]))
  // VLAN 1 goes last in each phase: it carries the management.
  const targets = [...target.vlans].map(normalizeVlan).sort((a, b) => (a.vid === 1 ? 1 : 0) - (b.vid === 1 ? 1 : 0) || a.vid - b.vid)

  for (const t of targets) {
    const c = byVid.get(t.vid)
    const u = union(c, t)
    if (!c || !sameMembers(c, u) || (c.name !== t.name && t.vid !== 1)) {
      ops.push({ op: "vlan", vlan: u, phase: "add", existed: !!c })
      byVid.set(t.vid, u)
    }
  }
  const groups = new Map<number, number[]>()
  target.pvids.forEach((pvid, i) => {
    if (cur.pvids[i] !== pvid) groups.set(pvid, [...(groups.get(pvid) ?? []), i + 1])
  })
  for (const [pvid, ports] of [...groups].sort((a, b) => a[0] - b[0])) ops.push({ op: "pvid", ports, pvid })
  for (const t of targets) {
    const now = byVid.get(t.vid)
    if (now && !sameMembers(now, t)) ops.push({ op: "vlan", vlan: t, phase: "final", existed: true })
  }
  const gone = cur.vlans.filter((v) => v.vid !== 1 && !find(target, v.vid)).map((v) => v.vid)
  if (gone.length) ops.push({ op: "delete", vids: sorted(gone) })
  if (ops.length) ops.push({ op: "save" })
  return ops
}

/** Apply one operation to a state (what the switch should look like afterwards; used by the runner to verify). */
export function applyOp(s: Dot1qState, op: SwitchOp): Dot1qState {
  switch (op.op) {
    case "enable":
      return op.on ? (s.enabled ? s : freshDot1q(s.portCount)) : { ...s, enabled: false, vlans: [], pvids: s.pvids.map(() => 1) }
    case "vlan": {
      const v = normalizeVlan(op.vlan)
      const vlans = s.vlans.some((x) => x.vid === v.vid) ? s.vlans.map((x) => (x.vid === v.vid ? v : x)) : [...s.vlans, v].sort((a, b) => a.vid - b.vid)
      return { ...s, vlans }
    }
    case "pvid":
      return { ...s, pvids: s.pvids.map((p, i) => (op.ports.includes(i + 1) ? op.pvid : p)) }
    case "delete":
      return { ...s, vlans: s.vlans.filter((v) => !op.vids.includes(v.vid)) }
    case "save":
      return s
  }
}

/** Differences between the switch and the layout the app applied (drift). Empty = matches. */
export function layoutDrift(actual: Dot1qState, expected: Dot1qState): Array<{ kind: "disabled" | "vlan-missing" | "vlan-members" | "vlan-extra" | "pvid"; vid?: number; port?: number; expected?: number; actual?: number }> {
  const out: Array<{ kind: "disabled" | "vlan-missing" | "vlan-members" | "vlan-extra" | "pvid"; vid?: number; port?: number; expected?: number; actual?: number }> = []
  if (!actual.enabled) return expected.enabled ? [{ kind: "disabled" }] : []
  for (const e of expected.vlans) {
    const a = actual.vlans.find((v) => v.vid === e.vid)
    if (!a) out.push({ kind: "vlan-missing", vid: e.vid })
    else if (!sameMembers(a, e)) out.push({ kind: "vlan-members", vid: e.vid })
  }
  for (const a of actual.vlans) if (!expected.vlans.some((e) => e.vid === a.vid)) out.push({ kind: "vlan-extra", vid: a.vid })
  expected.pvids.forEach((p, i) => {
    if (actual.pvids[i] !== p) out.push({ kind: "pvid", port: i + 1, expected: p, actual: actual.pvids[i] })
  })
  return out
}

/** "1-3,5" (like the switch's own pages). */
export function portList(ports: readonly number[]): string {
  const s = sorted(ports)
  const out: string[] = []
  for (let i = 0; i < s.length; i++) {
    let j = i
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++
    out.push(j > i ? `${s[i]}-${s[j]}` : String(s[i]))
    i = j
  }
  return out.join(",")
}

/** The VLANs a port belongs to, e.g. "1 sin etiqueta · 102-108 con etiqueta" (the words come from the caller). */
export function portMembership(s: Dot1qState, port: number): { untagged: number[]; tagged: number[] } {
  if (!s.enabled) return { untagged: [], tagged: [] }
  return {
    untagged: s.vlans.filter((v) => v.untagged.includes(port)).map((v) => v.vid),
    tagged: s.vlans.filter((v) => v.tagged.includes(port)).map((v) => v.vid),
  }
}
