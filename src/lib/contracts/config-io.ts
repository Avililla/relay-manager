import { z } from "zod"
import { IsoDateSchema, KeySchema, LabelSchema } from "./common"
import { EnterModeSchema, LineSettingsSchema, RelayPurposeSchema } from "./enums"
import { ConsoleBindingRecordSchema } from "./serial"
import { BoardInputSchema } from "./relays"
import { IdentifySchema, TemplateSpecSchema } from "./templates"
import {
  AccessKindSchema, AccessPolicySchema, CableIdentitySchema, CableKindSchema, CableNameSchema, CableSerialSchema, PortNumberSchema, SshUserSchema,
  SwitchPortSchema, TargetHostSchema, TargetModeSchema,
} from "./accesses"

export const ConfigExportV1Schema = z.object({
  format: z.literal("relay-manager-config"),
  version: z.literal(1),
  exportedAt: IsoDateSchema,
  appVersion: z.string(),
  settings: z.object({ labName: z.string().max(40), bannerText: z.string().max(120).nullable() }),
  roles: z.array(z.object({ name: z.string().min(1).max(40), description: z.string().max(200).nullable() })),
  templates: z.array(z.object({
    key: z.string().nullable(), name: z.string().min(1).max(40), description: z.string().max(300).nullable(),
    /** Files before 3.0.0: the old "predefined" flag (ignored). */
    builtin: z.boolean().optional(),
    /** "file": defined in a profile file when exported (an import always creates local templates). */
    source: z.enum(["local", "file"]).optional(), sourceFile: z.string().max(300).nullable().optional(),
    needsReview: z.boolean(), spec: TemplateSpecSchema,
  })),
  boards: z.array(BoardInputSchema.omit({ password: true }).extend({ hasPassword: z.boolean() })),
  equipment: z.array(z.object({
    name: z.string().min(1).max(60), serialNumber: z.string().max(60).nullable(), description: z.string().max(500).nullable(),
    templateName: z.string().nullable(), roles: z.array(z.string()),
    consoles: z.array(z.object({
      key: KeySchema, label: LabelSchema, line: LineSettingsSchema, enterMode: EnterModeSchema, localEcho: z.boolean(),
      hupcl: z.boolean(), captureToDisk: z.boolean(), identify: IdentifySchema,
      binding: ConsoleBindingRecordSchema.nullable(),
    })),
    relays: z.array(z.object({
      key: KeySchema.nullable(), label: LabelSchema, purpose: RelayPurposeSchema, requireConfirm: z.boolean(),
      defaultPulseMs: z.number().int().nullable(), boardName: z.string(), channel: z.number().int().min(1).max(32),
    })),
    /** Network accesses (files from 2.0.0 have none). */
    accesses: z.array(z.object({
      key: KeySchema, label: LabelSchema, kind: AccessKindSchema, port: PortNumberSchema, enabled: z.boolean(), policy: AccessPolicySchema,
      cableSerial: CableSerialSchema.nullable(), consoleKey: KeySchema.nullable(), targetHost: TargetHostSchema.nullable(), targetPort: PortNumberSchema.nullable(),
      /** "Red de equipos" (files before it have none: plain IP:port). */
      targetMode: TargetModeSchema.default("ip"), switchPort: SwitchPortSchema.nullable().default(null), sshUser: SshUserSchema.nullable().default(null),
    })).max(16).default([]),
  })),
  /** The cable inventory ("Cables"). */
  cableLabels: z.array(z.object({
    kind: CableKindSchema, identity: CableIdentitySchema, name: CableNameSchema, notes: z.string().max(200).nullable(),
  })).max(500).default([]),
})
export type ConfigExportV1 = z.infer<typeof ConfigExportV1Schema>
export const ImportConfigInputSchema = z.object({ json: z.string().min(2).max(2_000_000), dryRun: z.boolean().default(true) })
export interface ImportReportDTO {
  dryRun: boolean
  created: { roles: number; templates: number; boards: number; equipment: number }
  skipped: Array<{ kind: "role" | "template" | "board" | "equipment"; name: string; reason: string }>
  warnings: string[]
}
