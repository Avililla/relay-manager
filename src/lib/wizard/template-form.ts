// Template editor draft (§8.9 Plantillas, W2-B). Pure; unit-tested in template-form.test.ts.
import type { z } from "zod"
import { DEFAULT_LINE, type EnterMode, type LineSettings, type RelayPurpose } from "@/lib/contracts/enums"
import { formatEquipmentName, TemplateInputSchema, type TemplateDTO } from "@/lib/contracts/templates"
import { spanishIssue, zodFieldErrors, type FieldErrors } from "./field-errors"
import { accessDraftFromSlot, toTemplateAccessSlots, type AccessDraft } from "@/lib/accesses/draft"

export interface TemplateConsoleRow {
  key: string
  label: string
  line: LineSettings
  enterMode: EnterMode
  localEcho: boolean
  identify: { hostnameRegex?: string; bannerRegex?: string }
}
export interface TemplateRelayRow { key: string | null; label: string; purpose: RelayPurpose; requireConfirm: boolean; defaultPulseMs: number | null }

export interface TemplateForm {
  name: string
  description: string
  namePattern: string
  skipInterfaces: number[]
  consoles: TemplateConsoleRow[]
  relays: TemplateRelayRow[]
  accesses: AccessDraft[]
  markReviewed: boolean
}

export type TemplatePayload = z.input<typeof TemplateInputSchema>

export const DEFAULT_PATTERN = "{template} #{nn}"

export function blankTemplateForm(): TemplateForm {
  return {
    name: "", description: "", namePattern: DEFAULT_PATTERN, skipInterfaces: [],
    consoles: [{ key: "CONSOLA", label: "Consola", line: { ...DEFAULT_LINE }, enterMode: "cr", localEcho: false, identify: {} }],
    relays: [], accesses: [], markReviewed: false,
  }
}

export function templateFormFrom(t: TemplateDTO): TemplateForm {
  return {
    name: t.name,
    description: t.description ?? "",
    namePattern: t.spec.namePattern,
    skipInterfaces: [...t.spec.skipInterfaces].sort((a, b) => a - b),
    consoles: t.spec.consoles.map((c) => ({
      key: c.key, label: c.label, line: { ...c.line }, enterMode: c.enterMode, localEcho: c.localEcho,
      identify: { ...(c.identify.hostnameRegex ? { hostnameRegex: c.identify.hostnameRegex } : {}), ...(c.identify.bannerRegex ? { bannerRegex: c.identify.bannerRegex } : {}) },
    })),
    relays: t.spec.relays.map((r) => ({ key: r.key, label: r.label, purpose: r.purpose, requireConfirm: r.requireConfirm, defaultPulseMs: r.defaultPulseMs ?? null })),
    accesses: t.spec.accesses.map((a, i) => accessDraftFromSlot(a, `tpl-acc-${i}`)),
    markReviewed: false,
  }
}

function identifyOf(i: TemplateConsoleRow["identify"]): { hostnameRegex?: string; bannerRegex?: string } {
  const out: { hostnameRegex?: string; bannerRegex?: string } = {}
  if (i.hostnameRegex?.trim()) out.hostnameRegex = i.hostnameRegex.trim()
  if (i.bannerRegex?.trim()) out.bannerRegex = i.bannerRegex.trim()
  return out
}

/** createTemplate/updateTemplate input (without templateId/markReviewed). An empty description is null. */
export function buildTemplateInput(f: TemplateForm): TemplatePayload {
  return {
    name: f.name.trim(),
    description: f.description.trim() || null,
    spec: {
      version: 1,
      namePattern: f.namePattern.trim() || DEFAULT_PATTERN,
      skipInterfaces: [...new Set(f.skipInterfaces)].sort((a, b) => a - b),
      consoles: f.consoles.map((c) => ({ key: c.key, label: c.label.trim(), line: { ...c.line }, enterMode: c.enterMode, localEcho: c.localEcho, identify: identifyOf(c.identify) })),
      relays: f.relays.map((r) => ({ key: r.key ?? "", label: r.label.trim(), purpose: r.purpose, requireConfirm: r.requireConfirm, defaultPulseMs: r.defaultPulseMs })),
      accesses: toTemplateAccessSlots(f.accesses),
    },
  }
}

/** Same checks as the server (TemplateInputSchema), with dotted keys: `name`, `spec.consoles.1.key`… */
export function validateTemplateForm(f: TemplateForm): FieldErrors {
  const r = TemplateInputSchema.safeParse(buildTemplateInput(f), { error: spanishIssue })
  return r.success ? {} : zodFieldErrors(r.error)
}

/** "Equipo A #08" for the pattern, the template name and the equipment that already exists; null if unusable. */
export function namePreview(pattern: string, templateName: string, existingNames: readonly string[]): string | null {
  try {
    const name = formatEquipmentName(pattern.trim() || DEFAULT_PATTERN, templateName.trim() || "…", existingNames)
    return name.trim() ? name : null
  } catch {
    return null
  }
}

/** Dirty check that ignores whitespace-only differences the server would trim anyway. */
export function isTemplateDirty(f: TemplateForm, initial: TemplateForm): boolean {
  return f.markReviewed !== initial.markReviewed || JSON.stringify(buildTemplateInput(f)) !== JSON.stringify(buildTemplateInput(initial))
}

export function toggleInterface(list: readonly number[], n: number): number[] {
  return list.includes(n) ? list.filter((x) => x !== n) : [...list, n].sort((a, b) => a - b)
}
