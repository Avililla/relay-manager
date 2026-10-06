// Server-side read helpers for the W2-D admin pages. Reads go through the W1-C queries; the capture state comes
// from the runtime through getRuntime() only (§2.2 rule 2), never from Graph A modules.
import type { ReservedEquipment } from "@/components/admin/access-model"
import type { IsoDate } from "@/lib/contracts/common"
import { listEquipmentCards } from "@/server/queries/equipment"
import { getRuntime } from "@/server/runtime/registry"
import type { AuthUser } from "@/server/runtime/types"

/**
 * Every equipment with its role ids and active reservation holder, ordered as on Banco (admins see all);
 * `detail` = template · S/N. The holder lets the role editor warn about reservations a save would release.
 */
export async function equipmentAccessList(admin: AuthUser): Promise<Array<ReservedEquipment & { detail: string | null }>> {
  const cards = await listEquipmentCards(admin)
  return cards.map((c) => ({
    id: c.id, name: c.name, roleIds: c.roles.map((r) => r.id),
    detail: [c.templateName, c.serialNumber].filter(Boolean).join(" · ") || null,
    reservation: c.reservation ? { holderId: c.reservation.holderId, holderName: c.reservation.holderName } : null,
  }))
}

export interface CaptureStatus { state: "on" | "off" | "paused-disk"; totalBytes: number; lastPurgeAt: IsoDate | null }

/** Live continuous-capture state (§4.6) for Sistema > Consolas. */
export function captureStatus(): CaptureStatus {
  const c = getRuntime().serial.stats().capture
  return { state: c.state, totalBytes: c.totalBytes, lastPurgeAt: c.lastPurgeAt }
}
