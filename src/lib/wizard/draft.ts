// "Nuevo equipo" wizard draft (§8.9, W2-B). Pure: the component keeps a WizardDraft in a reducer and uses these
// helpers to seed it from a template, validate each step, build the createEquipment input and route server errors
// back to the step and row they belong to. Unit-tested in draft.test.ts.
import type { z } from "zod"
import type { CreateEquipmentInputSchema } from "@/lib/contracts/equipment"
import { DEFAULT_LINE, type EnterMode, type LineSettings, type MatchBy, type RelayPurpose } from "@/lib/contracts/enums"
import type { SerialSnapshotDTO } from "@/lib/contracts/serial"
import { formatEquipmentName, TemplateSpecSchema, type TemplateConsoleSlot, type TemplateDTO, type TemplateRelaySlot, type TemplateSpec } from "@/lib/contracts/templates"
import { mergeErrors, spanishIssue, zodFieldErrors, type FieldErrors } from "./field-errors"
import { accessDraftFromSlot, toAccessInputs, toTemplateAccessSlots, type AccessDraft } from "@/lib/accesses/draft"
import { findPort } from "./ports"

/** The "En blanco" choice (§3.3): 0 consoles, 0 relays, not a DB row. */
export const BLANK = "blank"
export const BLANK_NAME_PATTERN = "Equipo #{nn}"

export const WIZARD_STEPS = ["plantilla", "consolas", "conexiones", "accesos", "identidad", "revision"] as const
export type WizardStepId = (typeof WIZARD_STEPS)[number]
export const STEP = { template: 0, slots: 1, connections: 2, accesses: 3, identity: 4, review: 5 } as const

export interface ConsoleDraft {
  uid: string
  key: string
  label: string
  line: LineSettings
  enterMode: EnterMode
  localEcho: boolean
  identify: { hostnameRegex?: string; bannerRegex?: string }
  hupcl: boolean
  captureToDisk: boolean
}
export interface RelayDraft {
  uid: string
  key: string | null
  label: string
  purpose: RelayPurpose
  requireConfirm: boolean
  defaultPulseMs: number | null
}
export interface PortBinding { stableKey: string; matchBy: MatchBy }
export interface RelayTarget { boardId: string; channel: number }
/** A relay slot's board channel, or "skip" ("Omitir este relé"). A slot without an entry is omitted too. */
export type RelayAssignment = RelayTarget | "skip"

export interface WizardDraft {
  /** Template id, BLANK, or null before a choice. */
  choice: string | null
  consoles: ConsoleDraft[]
  relays: RelayDraft[]
  /** Port per console slot, by `ConsoleDraft.uid` (kept apart from the slot draft, §8.9). */
  bindings: Record<string, PortBinding>
  /** Board channel per relay slot, by `RelayDraft.uid`. */
  relayTargets: Record<string, RelayAssignment>
  /** Network accesses (JTAG, serial over TCP, Ethernet), seeded from the template. */
  accesses: AccessDraft[]
  name: string
  /** The user typed a name: template changes no longer replace it with a suggestion. */
  nameTouched: boolean
  serialNumber: string
  description: string
  roleIds: string[]
  /** "Guardar estas consolas y relés en la plantilla" (default off). */
  saveToTemplate: boolean
}

export type CreateEquipmentPayload = z.input<typeof CreateEquipmentInputSchema>

export function emptyDraft(): WizardDraft {
  return { choice: null, consoles: [], relays: [], bindings: {}, relayTargets: {}, accesses: [], name: "", nameTouched: false, serialNumber: "", description: "", roleIds: [], saveToTemplate: false }
}

export function consoleFromSlot(s: TemplateConsoleSlot, uid: string): ConsoleDraft {
  return {
    uid, key: s.key, label: s.label, line: { ...s.line }, enterMode: s.enterMode, localEcho: s.localEcho,
    identify: { ...(s.identify.hostnameRegex ? { hostnameRegex: s.identify.hostnameRegex } : {}), ...(s.identify.bannerRegex ? { bannerRegex: s.identify.bannerRegex } : {}) },
    hupcl: false, captureToDisk: true,
  }
}

export function relayFromSlot(s: TemplateRelaySlot, uid: string): RelayDraft {
  return { uid, key: s.key, label: s.label, purpose: s.purpose, requireConfirm: s.requireConfirm, defaultPulseMs: s.defaultPulseMs ?? null }
}

export function newConsoleDraft(taken: ReadonlyArray<string>, index: number, uid: string): ConsoleDraft {
  const set = new Set(taken)
  let n = index + 1
  while (set.has(`CONSOLA_${n}`)) n++
  return { uid, key: `CONSOLA_${n}`, label: `Consola ${n}`, line: { ...DEFAULT_LINE }, enterMode: "cr", localEcho: false, identify: {}, hupcl: false, captureToDisk: true }
}

export function newRelayDraft(taken: ReadonlyArray<string | null>, index: number, uid: string): RelayDraft {
  const set = new Set(taken.filter(Boolean))
  let n = index + 1
  while (set.has(`RELE_${n}`)) n++
  return { uid, key: `RELE_${n}`, label: `Relé ${n}`, purpose: "generic", requireConfirm: false, defaultPulseMs: null }
}

export function findTemplate(templates: readonly TemplateDTO[], choice: string | null): TemplateDTO | null {
  if (!choice || choice === BLANK) return null
  return templates.find((t) => t.id === choice) ?? null
}

/** "Equipo A #08": the template's namePattern with the first free number; "Equipo #01" for En blanco. */
export function suggestName(template: TemplateDTO | null, existingNames: readonly string[]): string {
  try {
    return template
      ? formatEquipmentName(template.spec.namePattern, template.name, existingNames)
      : formatEquipmentName(BLANK_NAME_PATTERN, "", existingNames)
  } catch {
    return ""
  }
}

/**
 * Picks a template (or En blanco). The slot draft, bindings, board channels and the save-back flag are reset from
 * the new template; the name follows the suggestion until the user edits it. Choosing the same option is a no-op.
 */
export function applyChoice(
  d: WizardDraft,
  choice: string,
  templates: readonly TemplateDTO[],
  existingNames: readonly string[],
  uid: () => string,
  resolveCable: (name: string) => string | null = () => null,
): WizardDraft {
  if (d.choice === choice) return d
  const t = findTemplate(templates, choice)
  return {
    ...d,
    choice,
    consoles: (t?.spec.consoles ?? []).map((s) => consoleFromSlot(s, uid())),
    relays: (t?.spec.relays ?? []).map((s) => relayFromSlot(s, uid())),
    accesses: (t?.spec.accesses ?? []).map((s) => accessDraftFromSlot(s, uid(), resolveCable)),
    bindings: {},
    relayTargets: {},
    saveToTemplate: false,
    name: d.nameTouched ? d.name : suggestName(t, existingNames),
  }
}

const withoutUid = <T extends { uid: string }>(row: T) => Object.fromEntries(Object.entries(row).filter(([k]) => k !== "uid"))
const slotsShape = (d: Pick<WizardDraft, "consoles" | "relays"> & { accesses?: AccessDraft[] }) =>
  JSON.stringify({ consoles: d.consoles.map(withoutUid), relays: d.relays.map(withoutUid), accesses: (d.accesses ?? []).map(withoutUid) })

/**
 * True when picking another template (or En blanco) would throw away work done after step 1: slots that differ
 * from what the current choice seeds, a chosen port or a board channel (or a skipped relay). Name, S/N,
 * description and roles survive a template change, so they do not count.
 */
export function choiceLosesWork(d: WizardDraft, templates: readonly TemplateDTO[], resolveCable: (name: string) => string | null = () => null): boolean {
  if (!d.choice) return false
  if (Object.keys(d.bindings).length || Object.keys(d.relayTargets).length) return true
  const t = findTemplate(templates, d.choice)
  const seeded = {
    consoles: (t?.spec.consoles ?? []).map((s) => consoleFromSlot(s, "")), relays: (t?.spec.relays ?? []).map((s) => relayFromSlot(s, "")),
    accesses: (t?.spec.accesses ?? []).map((s) => accessDraftFromSlot(s, "", resolveCable)),
  }
  return slotsShape(d) !== slotsShape(seeded)
}

/**
 * Bound ports that the live snapshot already shows as assigned to another equipment (the wizard's equipment does
 * not exist yet, so any assignment is someone else's): `consoles.<i>.binding` → the same message the server gives,
 * so the row is marked before "Crear equipo" instead of after the round trip. Ports not in the snapshot are left
 * to the server.
 */
export function bindingConflicts(
  d: Pick<WizardDraft, "consoles" | "bindings">,
  snapshot: SerialSnapshotDTO,
  text: (equipmentName: string, consoleKey: string) => string,
): FieldErrors {
  const fe: FieldErrors = {}
  d.consoles.forEach((c, i) => {
    const a = findPort(snapshot, d.bindings[c.uid]?.stableKey)?.assignment
    if (a) fe[`consoles.${i}.binding`] = [text(a.equipmentName, a.consoleKey)]
  })
  return fe
}

function cleanIdentify(i: ConsoleDraft["identify"]): { hostnameRegex?: string; bannerRegex?: string } {
  const out: { hostnameRegex?: string; bannerRegex?: string } = {}
  if (i.hostnameRegex?.trim()) out.hostnameRegex = i.hostnameRegex.trim()
  if (i.bannerRegex?.trim()) out.bannerRegex = i.bannerRegex.trim()
  return out
}

/** The slot draft as template slots (templateUpdate): no uid, bindings, board channels or equipment-only fields. */
export function toTemplateSlots(d: Pick<WizardDraft, "consoles" | "relays"> & { accesses?: AccessDraft[] }): { consoles: TemplateConsoleSlot[]; relays: TemplateRelaySlot[]; accesses?: ReturnType<typeof toTemplateAccessSlots> } {
  return {
    ...(d.accesses ? { accesses: toTemplateAccessSlots(d.accesses) } : {}),
    consoles: d.consoles.map((c) => ({ key: c.key, label: c.label.trim(), line: { ...c.line }, enterMode: c.enterMode, localEcho: c.localEcho, identify: cleanIdentify(c.identify) })),
    relays: d.relays.map((r) => ({ key: r.key ?? "", label: r.label.trim(), purpose: r.purpose, requireConfirm: r.requireConfirm, defaultPulseMs: r.defaultPulseMs })),
  }
}

/** Step 2: unique keys, key format, labels, regexes (TemplateSpecSchema). Keys: `consoles.<i>.<field>`, `relays.<i>.<field>`. */
export function validateSlots(d: Pick<WizardDraft, "consoles" | "relays">): FieldErrors {
  const spec = { version: 1 as const, namePattern: "{template} #{nn}", skipInterfaces: [], ...toTemplateSlots({ consoles: d.consoles, relays: d.relays }) }
  const r = TemplateSpecSchema.safeParse(spec, { error: spanishIssue })
  return r.success ? {} : zodFieldErrors(r.error)
}

const sameName = (a: string, b: string) => a.trim().toLocaleLowerCase("es") === b.trim().toLocaleLowerCase("es")

/** Step 4: name (required, 60 max, not taken), S/N (60 max), description (500 max). */
export function validateIdentity(d: Pick<WizardDraft, "name" | "serialNumber" | "description">, existingNames: readonly string[], text: {
  required: string; nameTaken: string; tooLong: (n: number) => string
}): FieldErrors {
  const fe: FieldErrors = {}
  const name = d.name.trim()
  if (!name) fe.name = [text.required]
  else if (name.length > 60) fe.name = [text.tooLong(60)]
  else if (existingNames.some((n) => sameName(n, name))) fe.name = [text.nameTaken]
  if (d.serialNumber.trim().length > 60) fe.serialNumber = [text.tooLong(60)]
  if (d.description.trim().length > 500) fe.description = [text.tooLong(500)]
  return fe
}

export const isRelayTarget = (a: RelayAssignment | undefined): a is RelayTarget => !!a && a !== "skip"

/**
 * The createEquipment input. Relay slots without a board channel (skipped or not assigned) are left out of
 * `relays`; `relayIndex[i]` is the draft index of input relay i, for mapping server errors back. With
 * `saveToTemplate` and a real template, `templateUpdate` carries the whole slot draft, skipped relays included.
 */
export function buildCreateInput(d: WizardDraft, template: TemplateDTO | null): { input: CreateEquipmentPayload; relayIndex: number[] } {
  const relayIndex: number[] = []
  const relays: CreateEquipmentPayload["relays"] = []
  d.relays.forEach((r, i) => {
    const t = d.relayTargets[r.uid]
    if (!isRelayTarget(t)) return
    relayIndex.push(i)
    relays.push({ key: r.key, label: r.label.trim(), purpose: r.purpose, requireConfirm: r.requireConfirm, defaultPulseMs: r.defaultPulseMs, boardId: t.boardId, channel: t.channel })
  })
  return {
    relayIndex,
    input: {
      name: d.name.trim(),
      serialNumber: d.serialNumber.trim() || null,
      description: d.description.trim() || null,
      roleIds: [...d.roleIds],
      templateId: template?.id ?? null,
      consoles: d.consoles.map((c) => ({
        key: c.key, label: c.label.trim(), line: { ...c.line }, enterMode: c.enterMode, localEcho: c.localEcho,
        hupcl: c.hupcl, captureToDisk: c.captureToDisk, identify: cleanIdentify(c.identify),
        binding: d.bindings[c.uid] ? { ...d.bindings[c.uid] } : null,
      })),
      relays,
      accesses: toAccessInputs(d.accesses),
      templateUpdate: d.saveToTemplate && template && template.source !== "file" ? toTemplateSlots(d) : null,
    },
  }
}

/**
 * Server field errors → draft keys: input relay indexes become draft indexes (skipped relays are not sent), and
 * `templateUpdate.consoles|relays.<i>` land on the slot rows they came from.
 */
export function remapCreateErrors(fe: FieldErrors, relayIndex: readonly number[]): FieldErrors {
  const out: FieldErrors = {}
  for (const [key, msgs] of Object.entries(fe)) {
    let k = key
    const rel = /^relays\.(\d+)(\..*)?$/.exec(k)
    if (rel) {
      const di = relayIndex[Number(rel[1])]
      k = `relays.${di ?? rel[1]}${rel[2] ?? ""}`
    }
    k = k.replace(/^templateUpdate\.(consoles|relays|accesses)\./, "$1.")
    out[k] = mergeErrors(out, { [k]: msgs })[k]
  }
  return out
}

/** The earliest step an error key belongs to, or null when only `_form` (or unknown keys) remain. */
export function stepForErrors(fe: FieldErrors): number | null {
  let best: number | null = null
  const take = (s: number) => {
    best = best === null ? s : Math.min(best, s)
  }
  for (const key of Object.keys(fe)) {
    if (/^(name|serialNumber|description|roleIds)(\.|$)/.test(key)) take(STEP.identity)
    else if (/^accesses(\.|$)/.test(key) || /^templateUpdate\.accesses(\.|$)/.test(key)) take(STEP.accesses)
    else if (/^consoles\.\d+\.binding(\.|$)/.test(key) || /^relays\.\d+\.(boardId|channel)(\.|$)/.test(key)) take(STEP.connections)
    else if (/^(consoles|relays)(\.|$)/.test(key)) take(STEP.slots)
    else if (/^templateId(\.|$)/.test(key)) take(STEP.template)
  }
  return best
}

/** Rows whose keys carry an error, for "mark the row" after a jump back. */
export function errorRows(fe: FieldErrors, list: "consoles" | "relays"): Set<number> {
  const rows = new Set<number>()
  const re = new RegExp(`^${list}\\.(\\d+)(\\.|$)`)
  for (const key of Object.keys(fe)) {
    const m = re.exec(key)
    if (m) rows.add(Number(m[1]))
  }
  return rows
}

/** Removes bindings and board channels whose rows no longer exist (after the slot editor removed rows). */
export function pruneAssignments(d: WizardDraft): WizardDraft {
  const cu = new Set(d.consoles.map((c) => c.uid))
  const ru = new Set(d.relays.map((r) => r.uid))
  const bindings = Object.fromEntries(Object.entries(d.bindings).filter(([uid]) => cu.has(uid)))
  const relayTargets = Object.fromEntries(Object.entries(d.relayTargets).filter(([uid]) => ru.has(uid)))
  if (Object.keys(bindings).length === Object.keys(d.bindings).length && Object.keys(relayTargets).length === Object.keys(d.relayTargets).length) return d
  return { ...d, bindings, relayTargets }
}

/** Assigns a port to one console slot; any other slot that had the same port loses it (a port has one console). */
export function assignPort(d: WizardDraft, uid: string, binding: PortBinding | null): WizardDraft {
  const bindings = { ...d.bindings }
  if (!binding) {
    delete bindings[uid]
    return { ...d, bindings }
  }
  for (const [other, b] of Object.entries(bindings)) if (other !== uid && b.stableKey === binding.stableKey) delete bindings[other]
  bindings[uid] = binding
  return { ...d, bindings }
}

/**
 * The key of the console slot (other than `exceptUid`) that holds `stableKey` in this draft, or null. The port
 * dialog and the port rows use it to say which slot a manual choice leaves without a port (see `assignPort`).
 */
export function portHolder(d: Pick<WizardDraft, "consoles" | "bindings">, stableKey: string | null | undefined, exceptUid?: string): string | null {
  if (!stableKey) return null
  return d.consoles.find((c) => c.uid !== exceptUid && d.bindings[c.uid]?.stableKey === stableKey)?.key ?? null
}

/** Applies a whole mapping (Asignar en orden, Ordenar según nombre de host): slotIndex → port. */
export function applyMapping(d: WizardDraft, mapping: ReadonlyArray<{ slotIndex: number; stableKey: string | null }>, matchByFor: (stableKey: string) => MatchBy): WizardDraft {
  let next = d
  for (const m of mapping) {
    const c = next.consoles[m.slotIndex]
    if (!c) continue
    next = assignPort(next, c.uid, m.stableKey ? { stableKey: m.stableKey, matchBy: matchByFor(m.stableKey) } : null)
  }
  return next
}

/** Channels already chosen by other relay slots of the draft ("boardId:channel"), for BoardChannelPicker `taken`. */
export function takenChannels(d: WizardDraft, exceptUid: string): string[] {
  return d.relays.flatMap((r) => {
    const t = d.relayTargets[r.uid]
    return r.uid !== exceptUid && isRelayTarget(t) ? [`${t.boardId}:${t.channel}`] : []
  })
}

/** True once the user changed anything worth a "¿Salir sin guardar?" prompt. */
export function isWizardDirty(d: WizardDraft, initial: WizardDraft): boolean {
  if (d.choice !== initial.choice) return true
  const strip = (x: WizardDraft) => JSON.stringify({
    consoles: x.consoles.map(withoutUid), relays: x.relays.map(withoutUid), accesses: x.accesses.map(withoutUid),
    bindings: Object.values(x.bindings), relayTargets: Object.values(x.relayTargets),
    name: x.nameTouched ? x.name : "", serialNumber: x.serialNumber, description: x.description, roleIds: x.roleIds, saveToTemplate: x.saveToTemplate,
  })
  return strip(d) !== strip(initial)
}

export type { TemplateSpec }
