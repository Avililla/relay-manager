// Equipment "Ajustes" draft (§8.9, W2-B). Pure; unit-tested in settings.test.ts.
import type { z } from "zod"
import type { EnterMode, LineSettings, RelayPurpose } from "@/lib/contracts/enums"
import { UpdateEquipmentInputSchema, type EquipmentEditDTO } from "@/lib/contracts/equipment"
import type { PortBinding, RelayTarget } from "./draft"
import { spanishIssue, zodFieldErrors, type FieldErrors } from "./field-errors"
import { accessDraftFromDTO, toAccessInputs, type AccessDraft } from "@/lib/accesses/draft"

/** "keep" leaves the saved binding as it is; null unbinds; an object binds to another port (§4.15 updateEquipment). */
export type SettingsBinding = "keep" | null | PortBinding

export interface SettingsConsoleRow {
  uid: string
  id?: string
  key: string
  label: string
  line: LineSettings
  enterMode: EnterMode
  localEcho: boolean
  identify: { hostnameRegex?: string; bannerRegex?: string }
  hupcl: boolean
  captureToDisk: boolean
  binding: SettingsBinding
}
export interface SettingsRelayRow {
  uid: string
  id?: string
  key: string | null
  label: string
  purpose: RelayPurpose
  requireConfirm: boolean
  defaultPulseMs: number | null
  target: RelayTarget | null
}
export interface SettingsDraft {
  name: string
  serialNumber: string
  description: string
  roleIds: string[]
  consoles: SettingsConsoleRow[]
  relays: SettingsRelayRow[]
  accesses: AccessDraft[]
}

export type UpdateEquipmentPayload = z.input<typeof UpdateEquipmentInputSchema>

export function settingsDraftFrom(dto: EquipmentEditDTO, uid: () => string): SettingsDraft {
  return {
    name: dto.name,
    serialNumber: dto.serialNumber ?? "",
    description: dto.description ?? "",
    roleIds: [...dto.roleIds],
    consoles: dto.consoles.map((c) => ({
      uid: uid(), id: c.id, key: c.key, label: c.label, line: { ...c.line }, enterMode: c.enterMode, localEcho: c.localEcho,
      identify: { ...(c.identify.hostnameRegex ? { hostnameRegex: c.identify.hostnameRegex } : {}), ...(c.identify.bannerRegex ? { bannerRegex: c.identify.bannerRegex } : {}) },
      hupcl: c.hupcl, captureToDisk: c.captureToDisk, binding: c.binding ? "keep" : null,
    })),
    relays: dto.relays.map((r) => ({
      uid: uid(), id: r.id, key: r.key, label: r.label, purpose: r.purpose, requireConfirm: r.requireConfirm, defaultPulseMs: r.defaultPulseMs,
      target: { boardId: r.boardId, channel: r.channel },
    })),
    accesses: dto.accesses.map((a) => accessDraftFromDTO(a, uid())),
  }
}

/** The editable configuration of an equipment, to notice when someone else changed it (not runtime state). */
export function configSignature(dto: EquipmentEditDTO): string {
  return JSON.stringify({
    n: dto.name, s: dto.serialNumber, d: dto.description, r: [...dto.roleIds].sort(),
    c: dto.consoles.map((c) => [c.id, c.key, c.label, c.line, c.enterMode, c.localEcho, c.hupcl, c.captureToDisk, c.identify, c.binding?.bindingKey ?? null, c.binding?.matchBy ?? null]),
    l: dto.relays.map((r) => [r.id, r.key, r.label, r.purpose, r.requireConfirm, r.defaultPulseMs, r.boardId, r.channel]),
    a: dto.accesses.map((a) => [a.id, a.key, a.label, a.kind, a.port, a.enabled, a.policy, a.cableSerial, a.consoleKey, a.targetHost, a.targetPort, a.targetMode, a.switchPort, a.sshUser]),
  })
}

function cleanIdentify(i: SettingsConsoleRow["identify"]): { hostnameRegex?: string; bannerRegex?: string } {
  const out: { hostnameRegex?: string; bannerRegex?: string } = {}
  if (i.hostnameRegex?.trim()) out.hostnameRegex = i.hostnameRegex.trim()
  if (i.bannerRegex?.trim()) out.bannerRegex = i.bannerRegex.trim()
  return out
}

/**
 * updateEquipment input. Relay rows without a board channel get a placeholder only when `placeholders` is set
 * (client-side validation of the other fields); a real save never sends them (validateSettings blocks it).
 */
export function buildUpdateInput(d: SettingsDraft, equipmentId: string, placeholders = false): UpdateEquipmentPayload {
  return {
    equipmentId,
    name: d.name.trim(),
    serialNumber: d.serialNumber.trim() || null,
    description: d.description.trim() || null,
    roleIds: [...d.roleIds],
    consoles: d.consoles.map((c) => ({
      ...(c.id ? { id: c.id } : {}),
      key: c.key, label: c.label.trim(), line: { ...c.line }, enterMode: c.enterMode, localEcho: c.localEcho, hupcl: c.hupcl,
      captureToDisk: c.captureToDisk, identify: cleanIdentify(c.identify),
      binding: c.binding === "keep" ? (c.id ? "keep" : null) : c.binding ? { ...c.binding } : null,
    })),
    relays: d.relays.flatMap((r, i) => {
      const target = r.target ?? (placeholders ? { boardId: `pending${i}`, channel: 1 } : null)
      if (!target) return []
      return [{ ...(r.id ? { id: r.id } : {}), key: r.key, label: r.label.trim(), purpose: r.purpose, requireConfirm: r.requireConfirm, defaultPulseMs: r.defaultPulseMs, boardId: target.boardId, channel: target.channel }]
    }),
    accesses: toAccessInputs(d.accesses),
  }
}

/** Client-side checks with the server's schema and dotted keys, plus "Elige placa y canal" for relays without one. */
export function validateSettings(d: SettingsDraft, equipmentId: string, text: { relayTargetRequired: string }): FieldErrors {
  const r = UpdateEquipmentInputSchema.safeParse(buildUpdateInput(d, equipmentId, true), { error: spanishIssue })
  const fe = r.success ? {} : zodFieldErrors(r.error)
  delete fe.equipmentId
  d.relays.forEach((row, i) => {
    if (!row.target) fe[`relays.${i}.channel`] = [text.relayTargetRequired]
  })
  return fe
}

/** The port a row uses after saving: its current binding for "keep", the new one, or none. */
export function effectivePort(row: SettingsConsoleRow, saved: ReadonlyMap<string, string | null>): string | null {
  if (row.binding === "keep") return row.id ? saved.get(row.id) ?? null : null
  return row.binding ? row.binding.stableKey : null
}

/**
 * Binds one console row; any other row that would end up on the same port is unbound (a port has one console).
 * `saved` maps console id → its saved bindingKey. Returns the keys of the rows that lost their port.
 */
export function assignSettingsPort(d: SettingsDraft, uid: string, binding: SettingsBinding, saved: ReadonlyMap<string, string | null>): { draft: SettingsDraft; displaced: string[] } {
  const row = d.consoles.find((c) => c.uid === uid)
  if (!row) return { draft: d, displaced: [] }
  const target = effectivePort({ ...row, binding }, saved)
  const displaced: string[] = []
  const consoles = d.consoles.map((c) => {
    if (c.uid === uid) return { ...c, binding }
    if (target && effectivePort(c, saved) === target) {
      displaced.push(c.key)
      return { ...c, binding: null }
    }
    return c
  })
  return { draft: { ...d, consoles }, displaced }
}

/** The key of the row (other than `exceptUid`) whose port after saving is `stableKey`, or null: the row a move unbinds. */
export function settingsPortHolder(d: SettingsDraft, stableKey: string | null | undefined, exceptUid: string, saved: ReadonlyMap<string, string | null>): string | null {
  if (!stableKey) return null
  return d.consoles.find((c) => c.uid !== exceptUid && effectivePort(c, saved) === stableKey)?.key ?? null
}

export function isSettingsDirty(d: SettingsDraft, initial: SettingsDraft): boolean {
  const strip = (x: SettingsDraft) => JSON.stringify({
    ...x,
    consoles: x.consoles.map((c) => Object.fromEntries(Object.entries(c).filter(([k]) => k !== "uid"))),
    relays: x.relays.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== "uid"))),
    accesses: x.accesses.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== "uid"))),
  })
  return strip(d) !== strip(initial)
}

/** Board channels already used by other relay rows of the draft ("boardId:channel"). */
export function takenSettingsChannels(d: SettingsDraft, exceptUid: string): string[] {
  return d.relays.flatMap((r) => (r.uid !== exceptUid && r.target ? [`${r.target.boardId}:${r.target.channel}`] : []))
}
