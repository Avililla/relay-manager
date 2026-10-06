import { z } from "zod"
import type { IsoDate } from "./common"
import { InputCaptureSchema, type InputCapture } from "./enums"

export interface SettingsDTO {
  labName: string; bannerText: string | null
  reservationTimeoutMin: number; reservationWarningMin: number
  captureRetentionDays: number; captureMaxTotalMb: number; captureMaxFileMb: number; inputCapture: InputCapture
  auditRetentionDays: number
  backupDailyEnabled: boolean; backupDailyHour: number; backupRetentionCount: number
  setupCompletedAt: IsoDate | null; updatedAt: IsoDate
}
/** Readable without a session and without a runtime (defaults then: DEFAULT_LAB_NAME, null, package version, "dev"). */
export interface PublicSettingsDTO { labName: string; bannerText: string | null; version: string; rev: string }
/** Partial patch. Cross-field rule (warning < timeout) is checked by SettingsService after merging. */
export const UpdateSettingsInputSchema = z.object({
  labName: z.string().trim().min(1).max(40),
  bannerText: z.string().trim().max(120).nullable(),
  reservationTimeoutMin: z.number().int().min(5).max(480),
  reservationWarningMin: z.number().int().min(1).max(60),
  captureRetentionDays: z.number().int().min(1).max(3650),
  captureMaxTotalMb: z.number().int().min(100).max(1_000_000),
  captureMaxFileMb: z.number().int().min(1).max(1024),
  inputCapture: InputCaptureSchema,
  auditRetentionDays: z.number().int().min(30).max(3650),
  backupDailyEnabled: z.boolean(),
  backupDailyHour: z.number().int().min(0).max(23),
  backupRetentionCount: z.number().int().min(1).max(365),
}).partial()
export type UpdateSettingsInput = z.infer<typeof UpdateSettingsInputSchema>
