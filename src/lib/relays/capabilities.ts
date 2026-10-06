// Driver capabilities (§4.8), shared by the drivers (server) and the board form (UI). Pure.
import type { DriverId } from "@/lib/contracts/enums"
import type { BoardOptions, DriverCapabilitiesDTO } from "@/lib/contracts/relays"
import { modelByName, RELAY_MODELS } from "./models"

/** Default TCP command port per driver (the board's `tcpPort` null means this). */
export const DEFAULT_TCP_PORT: Record<DriverId, number | null> = {
  "devantech-ds-http": null,
  "devantech-ds-ascii": 17123,
  "devantech-eth": 17494,
  simulated: null,
}

export function effectiveTcpPort(driver: DriverId, tcpPort: number | null): number | null {
  return tcpPort ?? DEFAULT_TCP_PORT[driver]
}

const MAX_ETH = Math.max(...RELAY_MODELS.filter((m) => m.family === "eth").map((m) => m.relays))

export function driverCapabilities(
  driver: DriverId,
  board: { model?: string | null; options?: BoardOptions | null } = {},
): DriverCapabilitiesDTO {
  switch (driver) {
    case "devantech-ds-http":
      return { absoluteSet: false, toggle: "native", pulse: "emulated", pulseMs: { min: 100, max: 60000, step: 100 }, maxRelays: 32 }
    case "devantech-ds-ascii":
      return { absoluteSet: true, toggle: "emulated", pulse: "native", pulseMs: { min: 19, max: 2147483647, step: 1 }, maxRelays: 32 }
    case "devantech-eth": {
      const m = modelByName(board.model)
      return {
        absoluteSet: true, toggle: "emulated", pulse: "native", pulseMs: { min: 100, max: 25500, step: 100 },
        maxRelays: m?.family === "eth" ? m.relays : MAX_ETH,
      }
    }
    case "simulated":
      return board.options?.sim?.absoluteSet === false
        ? { absoluteSet: false, toggle: "native", pulse: "emulated", pulseMs: { min: 100, max: 60000, step: 100 }, maxRelays: 32 }
        : { absoluteSet: true, toggle: "emulated", pulse: "native", pulseMs: { min: 19, max: 60000, step: 1 }, maxRelays: 32 }
  }
}
