// "Guardar estas consolas y relés en la plantilla" (§8.9 wizard step 5, W2-B). Pure; unit-tested.
import type { LineSettings, RelayPurpose } from "@/lib/contracts/enums"

/** The console slot fields a template stores. Other fields of a draft row (uid, binding, hupcl…) are ignored. */
export interface ConsoleSlotLike {
  key: string
  label: string
  line: LineSettings
  enterMode: string
  localEcho: boolean
  identify?: { hostnameRegex?: string | null; bannerRegex?: string | null } | null
}
/** The relay slot fields a template stores. Board assignment and the skipped flag are ignored. */
export interface RelaySlotLike {
  key: string | null
  label: string
  purpose: RelayPurpose
  requireConfirm: boolean
  defaultPulseMs?: number | null
}

export interface SlotDiff { added: string[]; removed: string[]; modified: string[]; reordered: boolean }
/** The access slot fields a template stores (ports, cables and "enabled" belong to each unit). */
export interface AccessSlotLike {
  key: string
  label: string
  kind: string
  policy: string
  consoleKey: string | null
  targetHost?: string | null
  targetPort: number | null
  targetMode?: string
}

export interface TemplateDiff { changed: boolean; consoles: SlotDiff; relays: SlotDiff; accesses: SlotDiff }

function consoleShape(c: ConsoleSlotLike): string {
  return JSON.stringify([
    c.label, c.line.baudRate, c.line.dataBits, c.line.parity, c.line.stopBits, c.line.flowControl, c.enterMode, c.localEcho,
    c.identify?.hostnameRegex || null, c.identify?.bannerRegex || null,
  ])
}

function relayShape(r: RelaySlotLike): string {
  return JSON.stringify([r.label, r.purpose, r.requireConfirm, r.defaultPulseMs ?? null])
}

function accessShape(a: AccessSlotLike): string {
  return JSON.stringify([a.label.trim(), a.kind, a.policy, a.kind === "serial" ? a.consoleKey : null, a.kind === "tcp" ? (a.targetHost?.trim() || null) : null, a.kind === "tcp" ? a.targetPort : null, a.kind === "tcp" ? (a.targetMode ?? "ip") : null])
}

function diffSlots<T>(draft: readonly T[], base: readonly T[], keyOf: (x: T) => string, shape: (x: T) => string): SlotDiff {
  const firstByKey = (list: readonly T[]) => {
    const m = new Map<string, T>()
    for (const x of list) if (!m.has(keyOf(x))) m.set(keyOf(x), x)
    return m
  }
  const d = firstByKey(draft)
  const b = firstByKey(base)
  const added = [...d.keys()].filter((k) => !b.has(k))
  const removed = [...b.keys()].filter((k) => !d.has(k))
  const modified = [...d.keys()].filter((k) => b.has(k) && shape(d.get(k) as T) !== shape(b.get(k) as T))
  const common = (list: readonly T[]) => [...new Set(list.map(keyOf))].filter((k) => d.has(k) && b.has(k))
  const reordered = common(draft).join("\u0000") !== common(base).join("\u0000")
  return { added, removed, modified, reordered }
}

const hasChanges = (s: SlotDiff) => s.added.length > 0 || s.removed.length > 0 || s.modified.length > 0 || s.reordered

/**
 * Compares the wizard's slot draft with the template spec it started from. Only slot fields count: console key,
 * label, line, Enter mode, local echo and identify expressions; relay key, label, purpose, confirmation and default
 * pulse. Bindings, board assignments, skipped relays and equipment-only fields never count as differences. Slots are
 * matched by key; a changed key is one removal plus one addition; a different order of the same keys is a change.
 */
export function diffAgainstTemplate(
  draft: { consoles: readonly ConsoleSlotLike[]; relays: readonly RelaySlotLike[]; accesses?: readonly AccessSlotLike[] },
  spec: { consoles: readonly ConsoleSlotLike[]; relays: readonly RelaySlotLike[]; accesses?: readonly AccessSlotLike[] },
): TemplateDiff {
  const consoles = diffSlots(draft.consoles, spec.consoles, (c) => c.key, consoleShape)
  const relays = diffSlots(draft.relays, spec.relays, (r) => r.key ?? "", relayShape)
  const accesses = diffSlots(draft.accesses ?? [], draft.accesses ? spec.accesses ?? [] : [], (a) => a.key, accessShape)
  return { changed: hasChanges(consoles) || hasChanges(relays) || hasChanges(accesses), consoles, relays, accesses }
}
