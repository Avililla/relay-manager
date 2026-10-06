import { z } from "zod"
import { IdSchema, type IsoDate } from "./common"

export interface ReservationDTO {
  equipmentId: string
  holderId: string; holderName: string; holderUsername: string
  reservedAt: IsoDate; expiresAt: IsoDate
  note: string | null
}
export const RESERVATION_CAUSES = ["reserve", "renew", "release", "expire", "force-release", "user-removed", "access-lost"] as const
export type ReservationCause = (typeof RESERVATION_CAUSES)[number]
export const ReserveInputSchema = z.object({ equipmentId: IdSchema, note: z.string().trim().max(120).nullable().default(null) })
export const ForceReleaseInputSchema = z.object({ equipmentId: IdSchema, reason: z.string().trim().min(3, "Indica el motivo").max(200) })
