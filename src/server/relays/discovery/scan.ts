// Subnet scan pipeline (§4.10 "Subnet scan"), per host:port. Read-only: every request goes through the probe
// transports (safety.ts) or a driver's detect path.
import type { DetectResultDTO } from "@/lib/contracts/relays"
import { modelByName, RELAY_MODELS } from "../pure/models"
import { rankDetectResults, type DriverRegistry } from "../registry"
import type { RelayTransports } from "../types"

export interface ScanProbeDeps {
  registry: DriverRegistry
  /** Probe-wrapped transports (safety.ts). */
  probe: RelayTransports
  timeoutMs: number
  connectTimeoutMs: number
  tcpPorts: { ascii: number; eth: number }
}

export interface ScanHit { ip: string; httpPort: number; detect: DetectResultDTO }

const ETH_BY_COUNT = new Map(RELAY_MODELS.filter((m) => m.family === "eth").map((m) => [m.relays, m.model]))

/**
 * 1. TCP connect (400 ms); 2. GET /index.xml (dS) → /index.htm → ST on 17123; 3. GET /status.xml (legacy ETH);
 * 4. GET / → 401 Basic → 0x10 on 17494; anything else is dropped.
 */
export async function probeHost(host: string, port: number, deps: ScanProbeDeps, signal: AbortSignal): Promise<ScanHit | null> {
  if (!(await deps.probe.tcpProbe({ host, port, timeoutMs: deps.connectTimeoutMs, signal }))) return null
  const ctx = { signal, timeoutMs: deps.timeoutMs }

  const ds = await deps.registry.get("devantech-ds-http").detect(host, { httpPort: port, tcpPort: null }, ctx)
  if (ds) {
    const ascii = await deps.registry.get("devantech-ds-ascii").detect(host, { httpPort: null, tcpPort: deps.tcpPorts.ascii }, ctx)
    const ranked = rankDetectResults(ascii ? [ds, ascii] : [ds])
    return ranked[0] ? { ip: host, httpPort: port, detect: ranked[0] } : null
  }

  const status = await deps.probe.httpGet({ host, port, path: "/status.xml", timeoutMs: deps.timeoutMs, signal }).catch(() => null)
  if (status?.status === 200 && /<relay1>[01]<\/relay1>/i.test(status.body)) {
    const count = new Set([...status.body.matchAll(/<relay(\d+)>/gi)].map((m) => m[1])).size
    const eth = await deps.registry.get("devantech-eth").detect(host, { httpPort: null, tcpPort: deps.tcpPorts.eth }, ctx)
    if (eth) return { ip: host, httpPort: port, detect: { ...eth, httpPort: port, evidence: [`GET /status.xml -> ${count} <relayN>`, ...eth.evidence] } }
    const model = ETH_BY_COUNT.get(count) ?? null
    return {
      ip: host, httpPort: port,
      detect: {
        driver: "devantech-eth", confidence: "medium", host, httpPort: port, tcpPort: null, model,
        moduleId: modelByName(model)?.moduleId ?? null, relayCount: count, hostname: null, mac: null, firmware: null,
        authRequired: false, options: { transport: "http" }, evidence: [`GET /status.xml -> ${count} <relayN>`],
      },
    }
  }

  const root = await deps.probe.httpGet({ host, port, path: "/", timeoutMs: deps.timeoutMs, signal }).catch(() => null)
  if (root?.status === 401 && /basic/i.test(root.headers["www-authenticate"] ?? "")) {
    const eth = await deps.registry.get("devantech-eth").detect(host, { httpPort: null, tcpPort: deps.tcpPorts.eth }, ctx)
    if (eth) return { ip: host, httpPort: port, detect: { ...eth, httpPort: port, evidence: ["GET / -> 401 Basic", ...eth.evidence] } }
  }
  return null
}

/** Runs `worker` over `items` with at most `concurrency` in flight; stops taking new items once aborted. */
export async function pool<T>(items: readonly T[], concurrency: number, signal: AbortSignal, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length && !signal.aborted) {
      const item = items[next++] as T
      await worker(item)
    }
  }))
}
