import type { ReservationDTO } from "@/lib/contracts/reservations"

/** Admins see everything; equipment without roles is visible to everyone; otherwise the role sets must intersect. */
export function canSeeEquipment(user: { isAdmin: boolean; roleIds: readonly string[] }, equipmentRoleIds: readonly string[]): boolean {
  if (user.isAdmin || equipmentRoleIds.length === 0) return true
  const mine = new Set(user.roleIds)
  return equipmentRoleIds.some((id) => mine.has(id))
}

/** Only the reservation holder controls relays and writes to consoles. */
export function canControl(user: { id: string }, reservation: Pick<ReservationDTO, "holderId"> | null): boolean {
  return reservation?.holderId === user.id
}

/**
 * Write rule for console release/retake/clear (§4.5 rule 8, D24): the holder → ok; an admin on an unreserved
 * unit → ok; an admin while someone else holds it → RESERVED_BY_OTHER; anyone else → NOT_HOLDER.
 */
export function canWriteConsoleEquipment(
  reservation: ReservationDTO | null,
  actor: { id: string; isAdmin: boolean },
): "ok" | "NOT_HOLDER" | "RESERVED_BY_OTHER" {
  if (reservation && reservation.holderId === actor.id) return "ok"
  if (actor.isAdmin) return reservation ? "RESERVED_BY_OTHER" : "ok"
  return "NOT_HOLDER"
}
