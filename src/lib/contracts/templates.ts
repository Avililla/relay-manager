import { z } from "zod"
import { IdSchema, KeySchema, LabelSchema, RegexStringSchema, type IsoDate } from "./common"
import { EnterModeSchema, LineSettingsSchema, RelayPurposeSchema } from "./enums"
import { refineAccesses, TemplateAccessSlotSchema } from "./accesses"

export const IdentifySchema = z.object({
  hostnameRegex: RegexStringSchema.optional(),
  bannerRegex: RegexStringSchema.optional(),
})
export const TemplateConsoleSlotSchema = z.object({
  key: KeySchema,
  label: LabelSchema,
  line: LineSettingsSchema,
  enterMode: EnterModeSchema.default("cr"),
  localEcho: z.boolean().default(false),
  identify: IdentifySchema.default({}),
})
export type TemplateConsoleSlot = z.infer<typeof TemplateConsoleSlotSchema>
export const TemplateRelaySlotSchema = z.object({
  key: KeySchema,
  label: LabelSchema,
  purpose: RelayPurposeSchema.default("generic"),
  requireConfirm: z.boolean().default(false),
  defaultPulseMs: z.number().int().min(19).max(60000).nullable().default(null),
})
export type TemplateRelaySlot = z.infer<typeof TemplateRelaySlotSchema>

function addDuplicateKeyIssues(keys: string[], path: string, ctx: z.RefinementCtx): void {
  const seen = new Set<string>()
  keys.forEach((k, i) => {
    if (seen.has(k)) ctx.addIssue({ code: "custom", path: [path, i, "key"], message: `Clave repetida: ${k}` })
    seen.add(k)
  })
}
export const TemplateSpecSchema = z.object({
  version: z.literal(1),
  namePattern: z.string().trim().min(1).max(40).default("{template} #{nn}"),
  skipInterfaces: z.array(z.number().int().min(0).max(15)).max(16).default([]),
  consoles: z.array(TemplateConsoleSlotSchema).max(16),
  relays: z.array(TemplateRelaySlotSchema).max(32),
  /** Network accesses (JTAG, serial over TCP, Ethernet). Missing in specs written before they existed. */
  accesses: z.array(TemplateAccessSlotSchema).max(16).default([]),
}).superRefine((s, ctx) => {
  addDuplicateKeyIssues(s.consoles.map((c) => c.key), "consoles", ctx)
  addDuplicateKeyIssues(s.relays.map((r) => r.key), "relays", ctx)
  refineAccesses(s.accesses, ctx, { consoleKeys: s.consoles.map((c) => c.key) })
})
export type TemplateSpec = z.infer<typeof TemplateSpecSchema>

/** "file": defined in <perfil>/plantillas/*.json (read-only here; «Duplicar» makes an editable copy). "local": made in the app. */
export const TEMPLATE_SOURCES = ["local", "file"] as const
export type TemplateSource = (typeof TEMPLATE_SOURCES)[number]

export interface TemplateDTO {
  id: string; key: string | null; name: string; description: string | null
  source: TemplateSource
  /** The file that defines it, relative to the profile dir ("plantillas/equipo-a.json"); null for local templates. */
  sourceFile: string | null
  /** A file template whose file is gone («Retirada»): kept for its equipment, not offered for new ones, deletable. */
  retired: boolean
  needsReview: boolean; spec: TemplateSpec; position: number
  equipmentCount: number; updatedAt: IsoDate
}

/** «Recargar plantillas» / `relay-manager plantillas recargar`. */
export interface TemplateSyncReportDTO {
  /** Where the files were read from (null: no profile). */
  dir: string | null
  created: string[]
  updated: string[]
  /** 2.x templates (local, same key) that now follow their file. */
  linked: string[]
  retired: string[]
  unchanged: number
  warnings: string[]
  /** "plantillas/x.json: consoles[0].key: …" */
  errors: string[]
}

export const TemplateInputSchema = z.object({
  name: z.string().trim().min(1).max(40),
  description: z.string().trim().max(300).nullable(),
  spec: TemplateSpecSchema,
})
export const UpdateTemplateInputSchema = TemplateInputSchema.extend({ templateId: IdSchema, markReviewed: z.boolean().default(false) })
export const TemplateRefInputSchema = z.object({ templateId: IdSchema })
export const DuplicateTemplateInputSchema = z.object({ templateId: IdSchema, name: z.string().trim().min(1).max(40) })
export const TemplatePropagationInputSchema = z.object({ templateId: IdSchema, equipmentIds: z.array(IdSchema).min(1).max(200) })
export interface PropagationPreviewDTO { items: Array<{ equipmentId: string; equipmentName: string; changes: string[] }> }

/** Pattern tokens: {template} {n} {nn} {nnn}. Returns the first free name (case-insensitive). */
export function formatEquipmentName(pattern: string, templateName: string, existingNames: readonly string[]): string {
  const taken = new Set(existingNames.map((n) => n.trim().toLowerCase()))
  const hasNumber = /\{n{1,3}\}/.test(pattern)
  const render = (i: number) => pattern
    .replaceAll("{template}", templateName)
    .replaceAll("{nnn}", String(i).padStart(3, "0"))
    .replaceAll("{nn}", String(i).padStart(2, "0"))
    .replaceAll("{n}", String(i))
  for (let i = 1; i <= 9999; i++) {
    const base = render(i)
    const name = hasNumber || i === 1 ? base : `${base} (${i})`
    if (!taken.has(name.toLowerCase())) return name
  }
  throw new Error("No quedan nombres libres para este patrón")
}
