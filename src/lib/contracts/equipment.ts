import { z } from "zod"
import { IdSchema, KeySchema, LabelSchema, type IsoDate } from "./common"
import { EnterModeSchema, LineSettingsSchema, MatchBySchema, RelayPurposeSchema,
  type EnterMode, type LineSettings, type MatchBy, type RelayPurpose } from "./enums"
import { StableKeySchema, type ConsoleBindingRecord, type ConsoleRuntimeDTO, type SerialSnapshotDTO } from "./serial"
import type { BoardChoiceDTO } from "./relays"
import type { ReservationDTO } from "./reservations"
import type { HealthCheckDTO } from "./system"
import { IdentifySchema, TemplateConsoleSlotSchema, TemplateRelaySlotSchema, type TemplateDTO } from "./templates"
import { AccessInputSchema, refineAccesses, TemplateAccessSlotSchema, type AccessDTO, type AccessEditContextDTO } from "./accesses"

export const ConsoleBindingInputSchema = z.object({ stableKey: StableKeySchema, matchBy: MatchBySchema })
export const ConsoleConfigInputSchema = z.object({
  id: IdSchema.optional(),                                // present = existing console
  key: KeySchema,
  label: LabelSchema,
  line: LineSettingsSchema,
  enterMode: EnterModeSchema,
  localEcho: z.boolean(),
  hupcl: z.boolean().default(false),
  captureToDisk: z.boolean().default(true),
  identify: IdentifySchema.default({}),
  binding: z.union([ConsoleBindingInputSchema, z.literal("keep"), z.null()]), // "keep" only with id
})
export type ConsoleConfigInput = z.infer<typeof ConsoleConfigInputSchema>
export const RelayChannelInputSchema = z.object({
  id: IdSchema.optional(),
  key: KeySchema.nullable(),
  label: LabelSchema,
  purpose: RelayPurposeSchema,
  requireConfirm: z.boolean(),
  defaultPulseMs: z.number().int().min(19).max(60000).nullable(),
  boardId: IdSchema,
  channel: z.number().int().min(1).max(32),
})
export type RelayChannelInput = z.infer<typeof RelayChannelInputSchema>

const identityShape = {
  name: z.string().trim().min(1, "Obligatorio").max(60),
  serialNumber: z.string().trim().max(60).nullable(),
  description: z.string().trim().max(500).nullable(),
  roleIds: z.array(IdSchema).max(50),
}

function refineComposition(
  v: {
    consoles: Array<{ id?: string; key: string; binding: unknown }>; relays: Array<{ boardId: string; channel: number }>
    accesses?: Array<{ key: string; port: number | null; kind: "jtag" | "serial" | "tcp"; consoleKey: string | null }>
  },
  ctx: z.RefinementCtx,
): void {
  if (v.accesses) refineAccesses(v.accesses, ctx, { consoleKeys: v.consoles.map((c) => c.key) })
  const keys = new Set<string>()
  const stable = new Set<string>()
  v.consoles.forEach((c, i) => {
    if (keys.has(c.key)) ctx.addIssue({ code: "custom", path: ["consoles", i, "key"], message: `Clave repetida: ${c.key}` })
    keys.add(c.key)
    if (c.binding === "keep" && !c.id) ctx.addIssue({ code: "custom", path: ["consoles", i, "binding"], message: "Asignación no válida" })
    if (typeof c.binding === "object" && c.binding !== null && "stableKey" in c.binding) {
      const sk = String((c.binding as { stableKey: string }).stableKey)
      if (stable.has(sk)) ctx.addIssue({ code: "custom", path: ["consoles", i, "binding"], message: "Ese puerto ya está asignado a otra consola" })
      stable.add(sk)
    }
  })
  const chans = new Set<string>()
  v.relays.forEach((r, i) => {
    const k = `${r.boardId}:${r.channel}`
    if (chans.has(k)) ctx.addIssue({ code: "custom", path: ["relays", i, "channel"], message: "Canal repetido" })
    chans.add(k)
  })
}

export const CreateEquipmentInputSchema = z.object({
  ...identityShape,
  templateId: IdSchema.nullable(),
  consoles: z.array(ConsoleConfigInputSchema.omit({ id: true })).max(16),
  relays: z.array(RelayChannelInputSchema.omit({ id: true })).max(32),
  /** Network accesses; `port: null` = next free port of RM_ACCESS_PORTS. */
  accesses: z.array(AccessInputSchema.omit({ id: true })).max(16).default([]),
  /** The wizard's slot draft to write back into the template (§4.15 step 5). Includes relay slots skipped for
   *  lack of a board; never carries bindings or equipment-only fields. Requires templateId. */
  templateUpdate: z.object({
    consoles: z.array(TemplateConsoleSlotSchema).max(16),
    relays: z.array(TemplateRelaySlotSchema).max(32),
    accesses: z.array(TemplateAccessSlotSchema).max(16).optional(),
  }).nullable().default(null),
}).superRefine(refineComposition)
export type CreateEquipmentInput = z.infer<typeof CreateEquipmentInputSchema>

export const UpdateEquipmentInputSchema = z.object({
  equipmentId: IdSchema,
  ...identityShape,
  consoles: z.array(ConsoleConfigInputSchema).max(16),
  relays: z.array(RelayChannelInputSchema).max(32),
  /** Omitted = the accesses stay as they are. */
  accesses: z.array(AccessInputSchema).max(16).optional(),
}).superRefine(refineComposition)
export type UpdateEquipmentInput = z.infer<typeof UpdateEquipmentInputSchema>

export const UpdateEquipmentBindingsInputSchema = z.object({
  equipmentId: IdSchema,
  bindings: z.array(z.object({ consoleId: IdSchema, binding: z.union([ConsoleBindingInputSchema, z.null()]) })).min(1).max(16),
})
export const DeleteEquipmentInputSchema = z.object({ equipmentId: IdSchema, confirmName: z.string() })
export const EquipmentRefInputSchema = z.object({ equipmentId: IdSchema })
export const ReorderEquipmentInputSchema = z.object({ equipmentIds: z.array(IdSchema).min(1).max(500) })

export interface ConsoleSummaryDTO {
  id: string; key: string; label: string; position: number
  line: LineSettings; enterMode: EnterMode; localEcho: boolean
  matchBy: MatchBy | null; adapterLabel: string | null
  adapterShort: string | null               // "FT4ABCDE·B", "USB 1-3.1·B", "ttyV0" (src/lib/serial/format.ts)
  runtime: ConsoleRuntimeDTO
}
export interface ConsoleDetailDTO extends ConsoleSummaryDTO {
  hupcl: boolean; captureToDisk: boolean
  identify: { hostnameRegex: string | null; bannerRegex: string | null }
  binding: (ConsoleBindingRecord & { lastSeenAt: IsoDate | null }) | null
}
export interface RelayChannelSummaryDTO {
  id: string; key: string | null; label: string; purpose: RelayPurpose; position: number
  requireConfirm: boolean; defaultPulseMs: number | null
  boardId: string; boardName: string; channel: number
  on: boolean | null; stale: boolean; boardOnline: boolean | null
  pulse: "native" | "emulated" | "none"; pulseMs: { min: number; max: number; step: number } | null
}
export interface EquipmentCardDTO {
  id: string; name: string; serialNumber: string | null; description: string | null
  templateId: string | null; templateName: string | null; position: number
  roles: Array<{ id: string; name: string }>
  consoles: ConsoleSummaryDTO[]
  relays: RelayChannelSummaryDTO[]
  reservation: ReservationDTO | null
  /** Network accesses (Banco card indicator, workspace "Accesos"). */
  accesses: AccessDTO[]
}
export interface EquipmentWorkspaceDTO extends Omit<EquipmentCardDTO, "consoles"> {
  consoles: ConsoleDetailDTO[]
  reservationWarningMin: number
}
export interface EquipmentEditDTO {
  id: string; name: string; serialNumber: string | null; description: string | null
  templateId: string | null; templateName: string | null; roleIds: string[]
  consoles: ConsoleDetailDTO[]; relays: RelayChannelSummaryDTO[]
  accesses: AccessDTO[]
  accessContext: AccessEditContextDTO
  reservation: ReservationDTO | null
  roles: Array<{ id: string; name: string }>              // all roles, for the picker
  boards: BoardChoiceDTO[]
  serial: SerialSnapshotDTO
  serialHints: HealthCheckDTO[]
  hideJtag: boolean
}
export interface WizardDataDTO {
  templates: TemplateDTO[]
  roles: Array<{ id: string; name: string }>
  boards: BoardChoiceDTO[]
  serial: SerialSnapshotDTO
  serialHints: HealthCheckDTO[]             // only SERIAL_HINT_CHECKS (system.ts), for an empty picker
  existingNames: string[]
  hideJtag: boolean
  accessContext: AccessEditContextDTO
}
