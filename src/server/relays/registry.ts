// Driver registry and autodetect (§4.8 "Registry and autodetect").
import type { DriverId } from "@/lib/contracts/enums"
import type { DetectResultDTO } from "@/lib/contracts/relays"
import { createDsAsciiDriver } from "./drivers/ds-ascii"
import { createDsHttpDriver } from "./drivers/ds-http"
import { createEthDriver } from "./drivers/eth"
import { createSimulatedDriver } from "./drivers/simulated"
import { modelByName } from "./pure/models"
import type { DriverDeps, ProbeContext, RelayDriver } from "./types"

export interface DriverRegistry {
  get(id: DriverId): RelayDriver
  /** Read-only detection with every Devantech driver; results ranked, best suggestion first. Never throws on I/O. */
  autodetect(host: string, ports: { httpPort: number | null; tcpPort: number | null }, ctx: ProbeContext): Promise<DetectResultDTO[]>
}

const RANK: Record<DetectResultDTO["confidence"], number> = { high: 0, medium: 1, low: 2 }
const ORDER: Record<DriverId, number> = { "devantech-ds-ascii": 0, "devantech-eth": 1, "devantech-ds-http": 2, simulated: 3 }

function withHint(r: DetectResultDTO, hint?: Partial<DetectResultDTO>): DetectResultDTO {
  if (!hint) return r
  return {
    ...r,
    mac: r.mac ?? hint.mac ?? null,
    hostname: r.hostname ?? hint.hostname ?? null,
    model: r.model ?? hint.model ?? null,
    moduleId: r.moduleId ?? hint.moduleId ?? null,
    relayCount: r.relayCount ?? hint.relayCount ?? null,
  }
}

/**
 * Merges the dS results (§4.8): the default suggestion is ds-ascii when `ST` answers, and the dS HTTP result still
 * contributes toggleVar, hostname and the HTTP port; the HTTP result gets the exact model from `ST`.
 */
export function rankDetectResults(results: DetectResultDTO[], hint?: Partial<DetectResultDTO>): DetectResultDTO[] {
  let out = results.map((r) => withHint(r, hint))
  const ascii = out.find((r) => r.driver === "devantech-ds-ascii")
  const http = out.find((r) => r.driver === "devantech-ds-http")
  if (ascii && http) {
    const merged: DetectResultDTO = {
      ...ascii,
      httpPort: http.httpPort,
      hostname: http.hostname ?? ascii.hostname,
      options: { ...http.options, ...ascii.options },
      evidence: [...ascii.evidence, ...http.evidence],
    }
    const info = modelByName(ascii.model ?? http.model)
    const httpFixed: DetectResultDTO = {
      ...http, tcpPort: ascii.tcpPort,
      model: http.model ?? info?.model ?? null, moduleId: http.moduleId ?? info?.moduleId ?? null,
      relayCount: http.relayCount ?? info?.relays ?? null,
      confidence: http.authRequired ? "low" : http.options.toggleVar ? "high" : "medium",
    }
    out = out.map((r) => (r === ascii ? merged : r === http ? httpFixed : r))
  }
  return out.sort((a, b) => RANK[a.confidence] - RANK[b.confidence] || ORDER[a.driver] - ORDER[b.driver])
}

export function createDriverRegistry(deps: DriverDeps): DriverRegistry {
  const drivers: Record<DriverId, RelayDriver> = {
    "devantech-ds-http": createDsHttpDriver(deps),
    "devantech-ds-ascii": createDsAsciiDriver(deps),
    "devantech-eth": createEthDriver(deps),
    simulated: createSimulatedDriver(deps),
  }
  return {
    get: (id) => drivers[id],
    async autodetect(host, ports, ctx) {
      const { httpPort, tcpPort } = ports
      // A given TCP port is probed only with the protocol it belongs to (17123 → ST, 17494 → 0x10); unknown ports get both.
      const runs: Array<Promise<DetectResultDTO | null>> = []
      if (httpPort) runs.push(drivers["devantech-ds-http"].detect(host, { httpPort, tcpPort: null }, ctx))
      if (tcpPort === null || tcpPort !== 17123) runs.push(drivers["devantech-eth"].detect(host, { httpPort: null, tcpPort: tcpPort ?? 17494 }, ctx))
      if (tcpPort === null || tcpPort !== 17494) runs.push(drivers["devantech-ds-ascii"].detect(host, { httpPort: null, tcpPort: tcpPort ?? 17123 }, ctx))
      const results = (await Promise.all(runs)).filter((r): r is DetectResultDTO => r !== null)
      return rankDetectResults(results, ctx.hint)
    },
  }
}
