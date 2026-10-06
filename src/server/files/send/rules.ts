// «Enviar a equipo»: who may send to an equipment (pure). The same rule as the Ethernet access (SSH) itself: the holder
// of the reservation, or anyone when the access is «Siempre» — and only while the access is enabled. Visibility (roles)
// is checked before, by src/server/access.ts.
import { sendErrors } from "@/lib/i18n/send"

export interface SendRuleInput {
  userId: string
  reservation: { holderId: string; holderName: string } | null
  policy: "reserved" | "always"
  enabled: boolean
}

export type SendRule = { ok: true } | { ok: false; code: "DISABLED" | "NOT_RESERVED" | "RESERVED_BY_OTHER"; reason: string }

export function canSendTo(i: SendRuleInput): SendRule {
  if (!i.enabled) return { ok: false, code: "DISABLED", reason: sendErrors.disabled }
  if (i.reservation?.holderId === i.userId) return { ok: true }
  if (i.policy === "always") return { ok: true }
  if (i.reservation) return { ok: false, code: "RESERVED_BY_OTHER", reason: sendErrors.reservedByOther(i.reservation.holderName) }
  return { ok: false, code: "NOT_RESERVED", reason: sendErrors.notReserved }
}

/** The Ethernet access used to send to an equipment: enabled first, then the one to port 22, then the first. */
export function pickAccess<T extends { enabled: boolean; targetPort: number | null; position: number }>(rows: readonly T[]): T | null {
  const sorted = [...rows].sort((a, b) =>
    Number(b.enabled) - Number(a.enabled) || Number(b.targetPort === 22) - Number(a.targetPort === 22) || a.position - b.position)
  return sorted[0] ?? null
}
