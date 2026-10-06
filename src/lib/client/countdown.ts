// Server clock and countdown maths (§2.7, §8.8 Countdown). Pure: shared by the provider and the component.
import type { IsoDate } from "@/lib/contracts/common"
import { formatDuration, formatTime } from "@/lib/i18n/format"

const MAX_SAMPLES = 5

/** Adds `serverNow - clientNow` to the last-5 sample window. Invalid dates are ignored. */
export function addClockSample(samples: readonly number[], serverNow: IsoDate, clientNow: number): number[] {
  const server = Date.parse(serverNow)
  if (!Number.isFinite(server) || !Number.isFinite(clientNow)) return [...samples]
  return [...samples, server - clientNow].slice(-MAX_SAMPLES)
}

/** Median of the samples; 0 without samples. */
export function clockOffset(samples: readonly number[]): number {
  if (!samples.length) return 0
  const s = [...samples].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2)
}

/** Milliseconds until `expiresAt` on the server clock. NaN for an unparseable date. */
export function remainingMs(expiresAt: IsoDate, clientNow: number, offset: number): number {
  return Date.parse(expiresAt) - (clientNow + offset)
}

/**
 * What a ticking countdown shows, in ms: the expiry floored to its second minus the (already floored) server now.
 * Both sides are on second boundaries, so a reservation made at 10:00:00.700 for 30 min reads 30:00 and not 30:01.
 */
export function displayRemainingMs(expiresAt: IsoDate, serverNow: number): number {
  return Math.floor(Date.parse(expiresAt) / 1000) * 1000 - serverNow
}

export type CountdownView =
  | { kind: "absolute"; text: string }
  | { kind: "remaining"; text: string; remainingMs: number }
  | { kind: "expiring"; text: string }

export const EXPIRING_TEXT = "Expirando…"

/**
 * Before mount (server render and hydration) the absolute end time is shown, so the markup never depends on the
 * client clock. After mount: "m:ss" (seconds rounded up); at or below zero: "Expirando…" until the server's
 * `reservation.changed` arrives (the sweeper runs every 5 s).
 */
export function countdownView(i: { expiresAt: IsoDate; mounted: boolean; clientNow: number; offset: number; timeZone?: string }): CountdownView {
  const end = Date.parse(i.expiresAt)
  if (!i.mounted) {
    return Number.isFinite(end) ? { kind: "absolute", text: `hasta ${formatTime(i.expiresAt, i.timeZone)}` } : { kind: "expiring", text: EXPIRING_TEXT }
  }
  const ms = displayRemainingMs(i.expiresAt, i.clientNow + i.offset)
  if (!Number.isFinite(ms) || ms <= 0) return { kind: "expiring", text: EXPIRING_TEXT }
  return { kind: "remaining", text: formatDuration(Math.ceil(ms / 1000) * 1000), remainingMs: ms }
}
