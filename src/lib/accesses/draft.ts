// Access rows while editing (wizard, equipment settings, template editor). Pure; unit-tested in draft.test.ts.
import type {
  AccessDTO, AccessInput, AccessKind, AccessPolicy, AccessSettingsDTO, CableLabelDTO, JtagSnapshotDTO, TargetMode, TemplateAccessSlot,
} from "@/lib/contracts/accesses"
import { z } from "zod"
import { AccessInputSchema, refineAccesses } from "@/lib/contracts/accesses"
import { spanishIssue, zodFieldErrors, type FieldErrors } from "@/lib/wizard/field-errors"
import { allocatePorts } from "./ports"

export interface AccessDraft {
  uid: string
  id?: string
  key: string
  label: string
  kind: AccessKind
  policy: AccessPolicy
  enabled: boolean
  /** null = the next free port when saving. */
  port: number | null
  cableSerial: string | null
  consoleKey: string | null
  targetHost: string
  targetPort: number | null
  /** Ethernet: "switch" (a port of the equipment switch; blank host = the equipment IP) or "ip". */
  targetMode: TargetMode
  switchPort: number | null
  sshUser: string | null
  /** Templates only: a cable label to use by default ("JTAG-07"). */
  cableName?: string | null
}

export function accessDraftFromSlot(s: TemplateAccessSlot, uid: string, resolveCable: (name: string) => string | null = () => null): AccessDraft {
  return {
    uid, key: s.key, label: s.label, kind: s.kind, policy: s.policy, enabled: true, port: null,
    cableSerial: s.kind === "jtag" && s.cableName ? resolveCable(s.cableName) : null,
    consoleKey: s.kind === "serial" ? s.consoleKey : null,
    targetHost: s.kind === "tcp" ? s.targetHost ?? "" : "",
    targetPort: s.kind === "tcp" ? s.targetPort : null,
    targetMode: s.kind === "tcp" ? s.targetMode : "ip",
    switchPort: null,
    sshUser: s.kind === "tcp" ? s.sshUser : null,
    ...(s.kind === "jtag" && s.cableName ? { cableName: s.cableName } : {}),
  }
}

export function accessDraftFromDTO(a: AccessDTO, uid: string): AccessDraft {
  return {
    uid, id: a.id, key: a.key, label: a.label, kind: a.kind, policy: a.policy, enabled: a.enabled, port: a.port,
    cableSerial: a.cableSerial, consoleKey: a.consoleKey, targetHost: a.targetHost ?? "", targetPort: a.targetPort,
    targetMode: a.targetMode, switchPort: a.switchPort, sshUser: a.sshUser,
  }
}

const KIND_PREFIX: Record<AccessKind, { key: string; label: string }> = {
  jtag: { key: "JTAG", label: "JTAG" }, serial: { key: "SERIE", label: "Serie" }, tcp: { key: "ETH", label: "Ethernet" },
}

/** `switchMode`: Ethernet rows start on "a port of the switch" (when the equipment network is set up). */
export function newAccessDraft(kind: AccessKind, takenKeys: readonly string[], uid: string, o: { switchMode?: boolean } = {}): AccessDraft {
  const taken = new Set(takenKeys)
  const p = KIND_PREFIX[kind]
  let n = taken.has(p.key) ? 2 : 1
  while (taken.has(`${p.key}_${n}`)) n++
  return {
    uid, key: `${p.key}_${n}`, label: `${p.label} ${n}`, kind, policy: "reserved", enabled: true, port: null,
    cableSerial: null, consoleKey: null, targetHost: "", targetPort: kind === "tcp" ? 22 : null,
    targetMode: kind === "tcp" && o.switchMode ? "switch" : "ip", switchPort: null, sshUser: kind === "tcp" ? "root" : null,
  }
}

/** Server input rows (fields of other kinds are cleared; blank host = none). */
export function toAccessInputs(rows: readonly AccessDraft[]): Array<AccessInput & { id?: string }> {
  return rows.map((r) => ({
    ...(r.id ? { id: r.id } : {}),
    key: r.key, label: r.label.trim(), kind: r.kind, enabled: r.enabled, policy: r.policy, port: r.port,
    cableSerial: r.kind === "jtag" ? r.cableSerial : null, cableName: null,
    consoleKey: r.kind === "serial" ? r.consoleKey : null,
    targetHost: r.kind === "tcp" && r.targetHost.trim() ? r.targetHost.trim() : null,
    targetPort: r.kind === "tcp" ? r.targetPort : null,
    targetMode: r.kind === "tcp" ? r.targetMode : "ip",
    switchPort: r.kind === "tcp" && r.targetMode === "switch" ? r.switchPort : null,
    sshUser: r.kind === "tcp" && r.sshUser?.trim() ? r.sshUser.trim() : null,
  }))
}

/** Template slots: no ports, cables or enabled flag (they belong to each unit). */
export function toTemplateAccessSlots(rows: readonly AccessDraft[]): TemplateAccessSlot[] {
  return rows.map((r) => ({
    key: r.key, label: r.label.trim(), kind: r.kind, policy: r.policy,
    consoleKey: r.kind === "serial" ? r.consoleKey : null,
    targetHost: r.kind === "tcp" && r.targetHost.trim() ? r.targetHost.trim() : null,
    targetPort: r.kind === "tcp" ? r.targetPort : null,
    cableName: r.kind === "jtag" && r.cableName?.trim() ? r.cableName.trim() : null,
    targetMode: r.kind === "tcp" ? r.targetMode : "ip",
    sshUser: r.kind === "tcp" && r.sshUser?.trim() ? r.sshUser.trim() : null,
  }))
}

/** The port each row will have after saving (same rules as the server); null when the range is full. */
export function previewPorts(rows: readonly AccessDraft[], ctx: { settings: AccessSettingsDTO; usedPorts: readonly number[] }): Array<number | null> {
  const req = rows.map((r) => r.port)
  const r = allocatePorts(req, { range: ctx.settings.range, httpPort: ctx.settings.httpPort, used: ctx.usedPorts })
  if (r.ok) return r.ports
  // The range is full: the rows that still fit get their port, the others none.
  const taken = new Set<number>([...ctx.usedPorts, ctx.settings.httpPort, ...req.flatMap((p) => (p === null ? [] : [p]))])
  let next = ctx.settings.range.from
  return req.map((p) => {
    if (p !== null) return p
    while (next <= ctx.settings.range.to && taken.has(next)) next++
    if (next > ctx.settings.range.to) return null
    taken.add(next)
    return next
  })
}

/** Serial accesses follow their console when its key changes (matched by the console row uid); a removed console → none. */
export function followConsoleRenames(rows: readonly AccessDraft[], before: ReadonlyArray<{ uid: string; key: string }>, after: ReadonlyArray<{ uid: string; key: string }>): AccessDraft[] {
  const now = new Map(after.map((c) => [c.uid, c.key]))
  const map = new Map<string, string | null>()
  for (const c of before) map.set(c.key, now.get(c.uid) ?? null)
  let changed = false
  const out = rows.map((r) => {
    if (r.kind !== "serial" || !r.consoleKey || !map.has(r.consoleKey)) return r
    const next = map.get(r.consoleKey) ?? null
    if (next === r.consoleKey) return r
    changed = true
    return { ...r, consoleKey: next }
  })
  return changed ? out : [...rows]
}

export interface CableChoice {
  serial: string
  name: string | null
  product: string | null
  connected: boolean
  /** free: connected and not used by another equipment; used: another equipment has it; offline: labelled, not connected. */
  group: "free" | "used" | "offline" | "unlabelled"
  usedBy: string[]
  /** Another row of this draft already chose it. */
  takenInDraft: boolean
}

/**
 * The JTAG cable picker: labelled cables by name (connected and free first, then the ones another equipment uses,
 * then the disconnected ones), and last the connected cables without a label ("Sin etiqueta").
 */
export function cableChoices(ctx: { jtag: JtagSnapshotDTO; labels: readonly CableLabelDTO[] }, o: { equipmentId: string | null; takenInDraft: readonly string[]; current: string | null }): CableChoice[] {
  const taken = new Set(o.takenInDraft)
  const connected = new Map(ctx.jtag.cables.flatMap((c) => (c.serial ? [[c.serial, c] as const] : [])))
  const out: CableChoice[] = []
  const seen = new Set<string>()
  for (const l of ctx.labels) {
    if (l.kind !== "jtag") continue
    const c = connected.get(l.identity)
    const usedBy = (c?.assignedTo ?? l.assignedTo).filter((a) => a.equipmentId !== o.equipmentId).map((a) => `${a.key} · ${a.equipmentName}`)
    out.push({
      serial: l.identity, name: l.name, product: c?.product ?? l.product, connected: !!c,
      group: !c ? "offline" : usedBy.length ? "used" : "free", usedBy, takenInDraft: taken.has(l.identity) && l.identity !== o.current,
    })
    seen.add(l.identity)
  }
  for (const c of ctx.jtag.cables) {
    if (!c.serial || seen.has(c.serial)) continue
    const usedBy = c.assignedTo.filter((a) => a.equipmentId !== o.equipmentId).map((a) => `${a.key} · ${a.equipmentName}`)
    out.push({ serial: c.serial, name: null, product: c.product, connected: true, group: "unlabelled", usedBy, takenInDraft: taken.has(c.serial) && c.serial !== o.current })
    seen.add(c.serial)
  }
  if (o.current && !seen.has(o.current)) {
    out.push({ serial: o.current, name: null, product: null, connected: false, group: "offline", usedBy: [], takenInDraft: false })
  }
  const rank = { free: 0, used: 1, offline: 2, unlabelled: 3 } as const
  return out.map((c, i) => ({ c, i }))
    .sort((a, b) => rank[a.c.group] - rank[b.c.group] || Number(a.c.takenInDraft) - Number(b.c.takenInDraft)
      || (a.c.name ?? a.c.serial).localeCompare(b.c.name ?? b.c.serial, "es", { numeric: true }) || a.i - b.i)
    .map((x) => x.c)
}

/** Client-side checks with the server's schema (keys, names, ports, consoles): `accesses.<i>.<field>`. */
export function validateAccessDrafts(rows: readonly AccessDraft[], consoleKeys: readonly string[]): FieldErrors {
  const schema = z.object({ accesses: z.array(AccessInputSchema).max(16) }).superRefine((v, ctx) => refineAccesses(v.accesses, ctx, { consoleKeys }))
  const r = schema.safeParse({ accesses: toAccessInputs(rows) }, { error: spanishIssue })
  return r.success ? {} : zodFieldErrors(r.error)
}
