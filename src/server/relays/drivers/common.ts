// Shared helpers for the drivers.
import type { DetectResultDTO } from "@/lib/contracts/relays"
import type { DriverId } from "@/lib/contracts/enums"
import { RELAY_TEXT } from "@/lib/i18n/relays"
import { probeTransports, UnsafeProbeError } from "../discovery/safety"
import { RelayDriverError, type DriverDeps, type ProbeContext, type RelayTransports } from "../types"
import { abortableSleep } from "../verify"

export interface DriverRuntime {
  t: RelayTransports
  /** Detect paths only: every request goes through assertSafeProbe / assertSafeHttpProbe. */
  probe: RelayTransports
  timeoutMs: number
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>
}

export function driverRuntime(deps: DriverDeps): DriverRuntime {
  return {
    t: deps.transports,
    probe: probeTransports(deps.transports, deps.log.child("discovery")),
    timeoutMs: deps.timeoutMs,
    sleep: deps.sleep ?? abortableSleep,
  }
}

/** Probe timeout: the context's, but never longer than the per-request one. */
export const probeTimeout = (rt: DriverRuntime, ctx: ProbeContext): number => Math.min(ctx.timeoutMs, rt.timeoutMs)

export function emptyDetect(driver: DriverId, host: string, hint?: Partial<DetectResultDTO>): DetectResultDTO {
  return {
    driver, confidence: "low", host, httpPort: null, tcpPort: null,
    model: hint?.model ?? null, moduleId: hint?.moduleId ?? null, relayCount: hint?.relayCount ?? null,
    hostname: hint?.hostname ?? null, mac: hint?.mac ?? null, firmware: null, authRequired: false, options: {}, evidence: [],
  }
}

export function channelCheck(channel: number, relayCount: number): void {
  if (!Number.isInteger(channel) || channel < 1 || channel > relayCount) throw new RelayDriverError(RELAY_TEXT.errUnknownRelay(channel), "config")
}

/** Detect paths resolve null on any network/protocol failure, but a safety violation is a bug and propagates. */
export function detectFailure(e: unknown): null {
  if (e instanceof UnsafeProbeError) throw e
  return null
}
