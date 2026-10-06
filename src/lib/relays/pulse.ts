// Pulse-duration helpers for the relay rail and the controller (§8.9 Relay rail: "Pulso"). Pure, UI-safe.
import type { DriverCapabilitiesDTO } from "@/lib/contracts/relays"
import { RELAY_TEXT } from "@/lib/i18n/relays"

/** The action schema accepts 19..60000 ms (PulseRelayInputSchema). */
export const PULSE_MS_LIMITS = { min: 19, max: 60000 } as const
export const DEFAULT_PULSE_MS = 500

/**
 * Effective range: the driver's range intersected with the action limits, kept on the driver's grid
 * (`pulseMs.min + k·step`); null when the board cannot pulse.
 */
export function pulseRange(caps: DriverCapabilitiesDTO): { min: number; max: number; step: number } | null {
  if (caps.pulse === "none" || !caps.pulseMs) return null
  const step = Math.max(1, caps.pulseMs.step)
  const base = caps.pulseMs.min
  const lo = Math.max(base, PULSE_MS_LIMITS.min)
  const hi = Math.min(caps.pulseMs.max, PULSE_MS_LIMITS.max)
  const min = base + Math.ceil((lo - base) / step) * step
  const max = base + Math.floor((hi - base) / step) * step
  return min <= max ? { min, max, step } : null
}

/** Clamps to the range and snaps to the driver step (rounding to the nearest step from `min`). */
export function clampPulseMs(ms: number, caps: DriverCapabilitiesDTO): number | null {
  const r = pulseRange(caps)
  if (!r || !Number.isFinite(ms)) return null
  const c = Math.min(r.max, Math.max(r.min, Math.round(ms)))
  const snapped = r.min + Math.round((c - r.min) / r.step) * r.step
  return Math.min(r.max, Math.max(r.min, snapped))
}

/** "Pulso" button duration (§8.9): `defaultPulseMs ?? clamp(500, pulseMs.min, pulseMs.max)`. */
export function defaultPulseFor(defaultPulseMs: number | null, caps: DriverCapabilitiesDTO): number | null {
  return clampPulseMs(defaultPulseMs ?? DEFAULT_PULSE_MS, caps)
}

/**
 * Spanish error for a pulse the board cannot do exactly (out of range, or off the driver step: an ETH board with
 * step 100 would round 150 ms to 200 ms), or null when `ms` is acceptable. Use clampPulseMs to snap a value first.
 */
export function pulseRangeError(ms: number, caps: DriverCapabilitiesDTO): string | null {
  const r = pulseRange(caps)
  if (!r) return RELAY_TEXT.pulseNotSupported
  if (!Number.isInteger(ms) || ms < r.min || ms > r.max) return RELAY_TEXT.pulseRange(r.min, r.max)
  if ((ms - r.min) % r.step !== 0) return RELAY_TEXT.pulseStep(r.min, r.max, r.step)
  return null
}

export function isPulseEmulated(caps: DriverCapabilitiesDTO): boolean {
  return caps.pulse === "emulated"
}
