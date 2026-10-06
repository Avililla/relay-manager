import { describe, expect, it } from "vitest"
import type { ReservationDTO } from "@/lib/contracts/reservations"
import {
  announcementText, canWriteConsoles, initialAnnouncements, isReservable, nextAnnouncement, reservationTransition, reservationView,
} from "./reservation-model"

const NOW = Date.parse("2026-09-23T10:00:00.000Z")
const iso = (ms: number) => new Date(ms).toISOString()
const res = (holderId: string, leftMs: number, p: Partial<ReservationDTO> = {}): ReservationDTO => ({
  equipmentId: "e1", holderId, holderName: holderId === "me" ? "Ana Ruiz" : "Jorge Duro", holderUsername: holderId,
  reservedAt: iso(NOW - 60_000), expiresAt: iso(NOW + leftMs), note: null, ...p,
})

describe("reservationView", () => {
  it("free", () => {
    expect(reservationView(null, "me", NOW, 5)).toEqual({ kind: "free" })
  })
  it("mine: normal, warning (≤ warningMin) and critical (< 60 s)", () => {
    expect(reservationView(res("me", 20 * 60_000), "me", NOW, 5)).toMatchObject({ kind: "mine", phase: "normal" })
    expect(reservationView(res("me", 5 * 60_000), "me", NOW, 5)).toMatchObject({ kind: "mine", phase: "warning" })
    expect(reservationView(res("me", 59_000), "me", NOW, 5)).toMatchObject({ kind: "mine", phase: "critical" })
    expect(reservationView(res("me", -1000), "me", NOW, 5)).toMatchObject({ kind: "mine", phase: "critical", remainingMs: 0 })
  })
  it("mine before mount (now = null) is normal with unknown remaining time", () => {
    expect(reservationView(res("me", 30_000), "me", null, 5)).toEqual({ kind: "mine", phase: "normal", remainingMs: null, expiresAt: iso(NOW + 30_000), note: null })
  })
  it("other: holder name shortened, note kept", () => {
    expect(reservationView(res("jd", 60_000, { note: "arranque en frío" }), "me", NOW, 5)).toEqual({
      kind: "other", holderName: "Jorge Duro", holderShort: "J. Duro", expiresAt: iso(NOW + 60_000), note: "arranque en frío",
    })
  })
})

describe("near-expiry announcements (exactly twice per expiry)", () => {
  const warn = 5
  it("announces at the warning threshold, then at 60 s, and never again for the same expiry", () => {
    const r = res("me", 10 * 60_000)
    let s = initialAnnouncements()
    const said: string[] = []
    // Walk the clock from 10 min left to 0 in 1 s steps.
    for (let left = 10 * 60_000; left >= 0; left -= 1000) {
      const step = nextAnnouncement(s, r, left, warn)
      s = step.state
      if (step.announce) said.push(`${step.announce}@${left}`)
    }
    expect(said).toEqual([`warning@${5 * 60_000}`, "final@60000"])
  })
  it("a page opened inside the warning window announces the warning once", () => {
    const r = res("me", 3 * 60_000)
    const a = nextAnnouncement(initialAnnouncements(), r, 3 * 60_000, warn)
    expect(a.announce).toBe("warning")
    expect(nextAnnouncement(a.state, r, 3 * 60_000 - 1000, warn).announce).toBeNull()
  })
  it("a page opened under 60 s only announces the final message", () => {
    const r = res("me", 40_000)
    const a = nextAnnouncement(initialAnnouncements(), r, 40_000, warn)
    expect(a.announce).toBe("final")
    expect(nextAnnouncement(a.state, r, 39_000, warn).announce).toBeNull()
  })
  it("a renewal (new expiresAt) arms both announcements again", () => {
    const r1 = res("me", 4 * 60_000)
    const a = nextAnnouncement(initialAnnouncements(), r1, 4 * 60_000, warn)
    expect(a.announce).toBe("warning")
    const r2 = { ...r1, expiresAt: iso(NOW + 30 * 60_000) }
    const b = nextAnnouncement(a.state, r2, 30 * 60_000, warn)
    expect(b.announce).toBeNull()
    expect(nextAnnouncement(b.state, r2, 5 * 60_000, warn).announce).toBe("warning")
  })
  it("nothing for free, other or unknown time", () => {
    expect(nextAnnouncement(initialAnnouncements(), null, 1000, warn).announce).toBeNull()
    expect(nextAnnouncement(initialAnnouncements(), res("me", 1000), Number.NaN, warn).announce).toBeNull()
    expect(nextAnnouncement(initialAnnouncements(), res("me", 0), 0, warn).announce).toBeNull()
  })
  it("texts", () => {
    expect(announcementText("warning", "Equipo A #07", 5 * 60_000)).toBe("Tu reserva de Equipo A #07 expira en 5 minutos. Pulsa Mantener o escribe en una consola.")
    expect(announcementText("warning", "Equipo A #07", 61_000)).toBe("Tu reserva de Equipo A #07 expira en 2 minutos. Pulsa Mantener o escribe en una consola.")
    expect(announcementText("final", "Equipo A #07", 60_000)).toBe("Tu reserva expira en 1 minuto.")
  })
})

describe("canWriteConsoles (D24: holder; admin only when the unit is free)", () => {
  it("matrix", () => {
    const user = { id: "me", isAdmin: false }
    const admin = { id: "me", isAdmin: true }
    expect(canWriteConsoles(res("me", 1000), user)).toBe(true)
    expect(canWriteConsoles(null, user)).toBe(false)
    expect(canWriteConsoles(res("jd", 1000), user)).toBe(false)
    expect(canWriteConsoles(null, admin)).toBe(true)
    expect(canWriteConsoles(res("jd", 1000), admin)).toBe(false)
    expect(canWriteConsoles(res("me", 1000), admin)).toBe(true)
  })
})

describe("reservationTransition (toasts on reservation.changed, §8.9)", () => {
  it("my reservation expired → expired toast", () => {
    expect(reservationTransition(res("me", 0), { reservation: null, cause: "expire", byName: null }, "me")).toEqual({ kind: "expired" })
  })
  it("someone else reserved while I was watching a free unit", () => {
    expect(reservationTransition(null, { reservation: res("jd", 60_000), cause: "reserve", byName: "Jorge Duro" }, "me")).toEqual({ kind: "reserved-by-other", who: "Jorge Duro" })
  })
  it("force release is shown by the server toast, not here; my own actions never toast", () => {
    expect(reservationTransition(res("me", 60_000), { reservation: null, cause: "force-release", byName: "Admin" }, "me")).toBeNull()
    expect(reservationTransition(null, { reservation: res("me", 60_000), cause: "reserve", byName: "Ana Ruiz" }, "me")).toBeNull()
    expect(reservationTransition(res("me", 60_000), { reservation: res("me", 90_000), cause: "renew", byName: "Ana Ruiz" }, "me")).toBeNull()
  })
})

describe("isReservable (a unit with nothing to operate offers no Reservar, same as the Banco card)", () => {
  it("needs at least one console or relay", () => {
    expect(isReservable({ consoleCount: 0, relayCount: 0 })).toBe(false)
    expect(isReservable({ consoleCount: 1, relayCount: 0 })).toBe(true)
    expect(isReservable({ consoleCount: 0, relayCount: 2 })).toBe(true)
  })
})
