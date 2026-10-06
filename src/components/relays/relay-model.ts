// Relay rail pure logic (§8.9): which control a channel gets, its pulse duration, the confirmation question and
// the state view (ON / OFF / ?; stale style). Pure and unit-tested.
import type { DriverCapabilitiesDTO } from "@/lib/contracts/relays"
import type { RelayChannelSummaryDTO } from "@/lib/contracts/equipment"
import type { ServerEvent } from "@/lib/contracts/events"
import { defaultPulseFor } from "@/lib/relays/pulse"
import { relayStateText } from "@/lib/relays/status"
import { relays as t } from "@/lib/i18n/banco"

export type RelayControl = { kind: "switch" } | { kind: "on-off" } | { kind: "pulse"; ms: number; emulated: boolean }

/** The channel's pulse capability in the shape the shared pulse helpers expect. */
function capsOf(r: Pick<RelayChannelSummaryDTO, "pulse" | "pulseMs">): DriverCapabilitiesDTO {
  return { absoluteSet: true, toggle: "native", pulse: r.pulse, pulseMs: r.pulseMs, maxRelays: 32 }
}

/** "Pulso" duration: `defaultPulseMs ?? 500`, clamped to the board range and snapped to its step; null = cannot pulse. */
export function pulseMsFor(r: Pick<RelayChannelSummaryDTO, "pulse" | "pulseMs" | "defaultPulseMs">): number | null {
  if (r.pulse === "none" || !r.pulseMs) return null
  return defaultPulseFor(r.defaultPulseMs, capsOf(r))
}

/**
 * Reset relays get "Pulso" (when the board can pulse); a channel whose state is unknown gets two buttons
 * ("Encender" / "Apagar"); everything else is an absolute-set switch. No optimistic flip (§8.9).
 */
export function relayControl(r: RelayChannelSummaryDTO, connectionStale = false): RelayControl {
  if (r.purpose === "reset") {
    const ms = pulseMsFor(r)
    if (ms !== null) return { kind: "pulse", ms, emulated: r.pulse === "emulated" }
  }
  // An unknown state (never read, or no live connection) gets two absolute commands: a switch would have to show
  // a position the board has not confirmed.
  if (r.on === null || connectionStale) return { kind: "on-off" }
  return { kind: "switch" }
}

/** `requireConfirm` channels ask before OFF and before a pulse (never before ON). */
export function confirmFor(r: Pick<RelayChannelSummaryDTO, "requireConfirm" | "purpose" | "label">, action: "on" | "off" | "pulse", equipmentName: string): string | null {
  if (!r.requireConfirm || action === "on") return null
  if (action === "off") return r.purpose === "power" ? t.confirmPowerOff(equipmentName) : t.confirmOff(r.label, equipmentName)
  return r.purpose === "reset" ? t.confirmResetPulse(equipmentName) : t.confirmPulse(r.label, equipmentName)
}

export interface RelayStateView { text: string; tone: "on" | "off" | "unknown"; stale: boolean }

/**
 * ON (ok fill) / OFF (neutral outline) / ? (hatched). Without a live connection every state is "?" in the stale
 * style (§8.9); a channel the server marks stale keeps its last value, flagged stale ("Último estado 13:02").
 */
export function relayStateView(r: Pick<RelayChannelSummaryDTO, "on" | "stale">, connectionStale: boolean): RelayStateView {
  if (connectionStale) return { text: relayStateText(null), tone: "unknown", stale: true }
  return { text: relayStateText(r.on), tone: r.on === null ? "unknown" : r.on ? "on" : "off", stale: r.stale }
}

export interface RelayLive { relays: RelayChannelSummaryDTO[]; at: string | null }

export function reduceRelayLive(s: RelayLive, e: ServerEvent, equipmentId: string): RelayLive {
  if (e.type !== "relay.state" || e.equipmentId !== equipmentId) return s
  const byId = new Map(e.channels.map((c) => [c.channelId, c]))
  let changed = false
  const relays = s.relays.map((r) => {
    const c = byId.get(r.id)
    if (!c || (c.on === r.on && c.stale === r.stale)) return r
    changed = true
    return { ...r, on: c.on, stale: c.stale }
  })
  return { relays: changed ? relays : s.relays, at: e.at }
}

/** Channels in their configured order. */
export function purposeOrder<R extends Pick<RelayChannelSummaryDTO, "position">>(relays: readonly R[]): R[] {
  return [...relays].sort((a, b) => a.position - b.position)
}
