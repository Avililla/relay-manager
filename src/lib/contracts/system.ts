import { z } from "zod"
import type { IsoDate } from "./common"
import type { ViewerDTO } from "./users"

export type HealthLevel = "ok" | "warn" | "fail" | "info"
export type HealthGroup = "runtime" | "data" | "serial" | "relays" | "accesses" | "network" | "clock" | "service"
export interface HealthCheckDTO { id: string; group: HealthGroup; level: HealthLevel; label: string; message: string; hint: string | null }
/** The fast subset shown next to empty serial pickers (wizard, Ajustes, Descubrimiento). */
export const SERIAL_HINT_CHECKS = ["serial.dialout", "serial.devices", "serial.modemmanager", "serial.brltty"] as const

export const BackupNameSchema = z.string().regex(/^relay-manager-\d{8}T\d{6}Z-[0-9A-Za-z.+-]+\.db$/)
export const BackupRefInputSchema = z.object({ name: BackupNameSchema })
export const CreateBackupInputSchema = z.strictObject({})
export interface BackupDTO { name: string; label: string; createdAt: IsoDate; sizeBytes: number; appVersion: string | null }

export interface SystemInfoDTO {
  version: string; rev: string; buildId: string; builtAt: string | null; node: string
  mode: "native" | "portable" | "docker" | "dev"
  host: string; port: number; tls: boolean
  dataDir: string; dbFile: string; dbSizeBytes: number
  captureDir: string; captureSizeBytes: number; backupDir: string; configFile: string | null
  urls: string[]; startedAt: IsoDate; uptimeSec: number; platform: string
}
export interface ShellDTO {
  labName: string; bannerText: string | null
  viewer: ViewerDTO
  version: string; buildId: string
  serverNow: IsoDate                             // seeds the server clock offset before SSE connects
  reservationWarningMin: number
  myReservations: Array<{ equipmentId: string; equipmentName: string; expiresAt: IsoDate }>   // TopBar near-expiry chip
  unassignedPorts: number | null                 // admins only
  capturePaused: boolean | null                  // admins only: any console in "paused-disk"
  filesEnabled?: boolean                         // "Archivos" in the navigation (RM_FILES_ENABLED); absent = true
}
