// Reservation pure logic (§8.6, §8.9): chip view, near-expiry announcements (exactly twice per expiry), the D24
// console write rule and the toasts that follow a reservation change. Pure and unit-tested.
import type { ReservationCause, ReservationDTO } from "@/lib/contracts/reservations"
import { reservation as t, shortName } from "@/lib/i18n/banco"

export const CRITICAL_MS = 60_000

export type ReservationView =
  | { kind: "free" }
  | { kind: "mine"; phase: "normal" | "warning" | "critical"; remainingMs: number | null; expiresAt: string; note: string | null }
  | { kind: "other"; holderName: string; holderShort: string; expiresAt: string; note: string | null }

/**
 * `now` is server time, or null before mount (the markup must not depend on the clock then). `warningMin` is
 * `reservationWarningMin`: at or under it the holder's chip turns warn, under 60 s danger.
 */
export function reservationView(r: ReservationDTO | null, viewerId: string, now: number | null, warningMin: number): ReservationView {
  if (!r) return { kind: "free" }
  if (r.holderId !== viewerId) {
    return { kind: "other", holderName: r.holderName, holderShort: shortName(r.holderName), expiresAt: r.expiresAt, note: r.note }
  }
  if (now === null) return { kind: "mine", phase: "normal", remainingMs: null, expiresAt: r.expiresAt, note: r.note }
  const end = Date.parse(r.expiresAt)
  const left = Number.isFinite(end) ? Math.max(0, end - now) : null
  const phase = left === null ? "normal" : left < CRITICAL_MS ? "critical" : left <= warningMin * 60_000 ? "warning" : "normal"
  return { kind: "mine", phase, remainingMs: left, expiresAt: r.expiresAt, note: r.note }
}

export type Announcement = "warning" | "final"
export interface AnnouncementState { key: string | null; warning: boolean; final: boolean }

export function initialAnnouncements(): AnnouncementState {
  return { key: null, warning: false, final: false }
}

/**
 * The single `role="status"` region of ReservationControl speaks exactly twice per expiry (§8.9): at the warning
 * threshold and at 60 s. A new `expiresAt` (a renewal) arms both again. A page opened inside the window says the
 * pending message once; under 60 s only the final one. `mine` is the viewer's own reservation (null otherwise).
 */
export function nextAnnouncement(s: AnnouncementState, mine: ReservationDTO | null, remainingMs: number, warningMin: number): { state: AnnouncementState; announce: Announcement | null } {
  if (!mine || !Number.isFinite(remainingMs) || remainingMs <= 0) return { state: s, announce: null }
  const state = s.key === mine.expiresAt ? s : { key: mine.expiresAt, warning: false, final: false }
  if (remainingMs <= CRITICAL_MS) {
    if (state.final) return { state, announce: null }
    return { state: { ...state, warning: true, final: true }, announce: "final" }
  }
  if (remainingMs <= warningMin * 60_000 && !state.warning) return { state: { ...state, warning: true }, announce: "warning" }
  return { state, announce: null }
}

export function announcementText(kind: Announcement, equipmentName: string, remainingMs: number): string {
  if (kind === "final") return t.announceFinal
  return t.announceWarning(equipmentName, Math.max(1, Math.ceil(remainingMs / 60_000)))
}

/** A unit with no consoles and no relays has nothing to operate: no "Reservar" while it is free (§8.9). */
export function isReservable(e: { consoleCount: number; relayCount: number }): boolean {
  return e.consoleCount > 0 || e.relayCount > 0
}

/** D24: the holder writes; an admin may release/retake/clear only while the unit is free. */
export function canWriteConsoles(r: ReservationDTO | null, viewer: { id: string; isAdmin: boolean }): boolean {
  if (r) return r.holderId === viewer.id
  return viewer.isAdmin
}

export type ReservationToast = { kind: "expired" } | { kind: "reserved-by-other"; who: string }

/**
 * What a viewer is told after `reservation.changed` (§8.9 toasts): their reservation expired, or someone else
 * reserved the unit they are looking at. A forced release is announced by the server's own `toast` event, and the
 * viewer's own actions need no toast.
 */
export function reservationTransition(prev: ReservationDTO | null, next: { reservation: ReservationDTO | null; cause: ReservationCause; byName: string | null }, viewerId: string): ReservationToast | null {
  if (next.cause === "expire" && prev?.holderId === viewerId && !next.reservation) return { kind: "expired" }
  const r = next.reservation
  if (next.cause === "reserve" && r && r.holderId !== viewerId && prev?.holderId !== r.holderId) return { kind: "reserved-by-other", who: r.holderName }
  return null
}
