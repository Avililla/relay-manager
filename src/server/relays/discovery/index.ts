// Relay discovery service (§4.10): passive UDP listener (receive only), active UDP discovery and the subnet scan,
// all merged into one known-boards map.
import crypto from "node:crypto"
import type dgram from "node:dgram"
import os from "node:os"
import type { DetectResultDTO, DiscoveredBoardDTO, RelayDiscoveryResultDTO, RelayScanInput } from "@/lib/contracts/relays"
import { RELAY_TEXT } from "@/lib/i18n/relays"
import type { AppConfig } from "@/server/config/schema"
import { DomainError } from "@/server/errors"
import type { Logger } from "@/server/log"
import type { ActorRef, AuditService, EventBus, RelayDiscoveryService } from "@/server/runtime/types"
import type { KnownBoardRef } from "../controller"
import { withOpSignal } from "../op-signal"
import type { DriverRegistry } from "../registry"
import { defaultTransports } from "../transport"
import type { RelayTransports } from "../types"
import { abortableSleep } from "../verify"
import { DISCOVERY_REQUEST, parseAnnouncement, type Announcement } from "./announce"
import { createKnownBoards, type KnownUpdate } from "./known"
import {
  defaultScanCidrs, expandScanTargets, isEnrichable, lanInterfaces, ownAddresses, type OsInterfaces,
} from "./net"
import { probeTransports } from "./safety"
import { pool, probeHost, type ScanHit } from "./scan"
import { bindUdp, closeUdp, createRateLimiter, defaultUdpFactory, sendDatagram, type UdpSocketFactory } from "./udp"

export interface DiscoveryTiming {
  repeats: number            // active: sends per target (3)
  intervalMs: number         // active: between sends (500)
  collectMs: number          // active: listen after the last send (2000)
  publishMinIntervalMs: number
  progressMs: number         // scan: discovery.progress period (250)
  connectTimeoutMs: number   // scan: TCP connect (400)
  maxPerSec: number          // passive: datagrams processed per second (200)
  maxBytes: number           // datagrams over this are dropped (1472)
  enrichConcurrency: number  // 8
  scanConcurrency: number    // 64
  maxReplies: number         // active: distinct replies collected per run (64); the rest are dropped with a warning
}
const DEFAULT_TIMING: DiscoveryTiming = {
  repeats: 3, intervalMs: 500, collectMs: 2000, publishMinIntervalMs: 5000, progressMs: 250, connectTimeoutMs: 400,
  maxPerSec: 200, maxBytes: 1472, enrichConcurrency: 8, scanConcurrency: 64, maxReplies: 64,
}

export interface RelayDiscoveryDeps {
  config: AppConfig
  log: Logger
  bus: EventBus
  audit: AuditService
  registry: DriverRegistry
  /** Registered boards, for the MAC/host cross-reference (the controller's view; never written from here). */
  boards: () => KnownBoardRef[]
  transports?: RelayTransports
  networkInterfaces?: () => OsInterfaces
  now?: () => Date
  createSocket?: UdpSocketFactory
  timing?: Partial<DiscoveryTiming>
  /** Scan step 2/4 TCP ports (17123 / 17494); tests use simulator ports. */
  scanTcpPorts?: { ascii: number; eth: number }
}

export interface RelayDiscoveryImpl extends RelayDiscoveryService {
  start(): Promise<void>
  stop(): Promise<void>
  /** Processes one datagram exactly like the UDP socket handler does (size cap, rate limit, parse, merge). */
  ingest(buf: Buffer, fromIp: string): void
}

export function createRelayDiscovery(deps: RelayDiscoveryDeps): RelayDiscoveryImpl {
  const log = deps.log.child("discovery")
  const cfg = deps.config.relays
  const timing: DiscoveryTiming = { ...DEFAULT_TIMING, ...deps.timing }
  const now = deps.now ?? (() => new Date())
  const ifaces = deps.networkInterfaces ?? (() => os.networkInterfaces())
  const createSocket = deps.createSocket ?? defaultUdpFactory
  const probe = probeTransports(deps.transports ?? defaultTransports, log)
  const scanPorts = deps.scanTcpPorts ?? { ascii: 17123, eth: 17494 }
  const life = new AbortController()
  const limiter = createRateLimiter(timing.maxPerSec, now)
  const known = createKnownBoards({
    now, boards: deps.boards, max: 256, publishMinIntervalMs: timing.publishMinIntervalMs,
    publish: (board) => deps.bus.publish({ type: "relay.discovered", board }, { kind: "admins" }),
  })

  let passive: dgram.Socket | null = null
  let collector: { found: Map<string, Announcement>; dropped: number } | null = null
  let udpRun: Promise<RelayDiscoveryResultDTO> | null = null
  let scanRun: { key: string; promise: Promise<RelayDiscoveryResultDTO> } | null = null

  function fromAnnouncement(a: Announcement, extra: Partial<KnownUpdate> = {}): KnownUpdate {
    return {
      ip: a.ip, mac: a.mac, hostname: a.hostname ?? a.macName, model: a.model, moduleId: a.moduleId,
      tcpPort: a.tcpPort, httpPort: a.httpPort, hints: a.hints, ...extra,
    }
  }

  function ingest(buf: Buffer, fromIp: string): void {
    if (buf.length > timing.maxBytes) return
    if (!limiter.allow()) return
    const ip = fromIp.replace(/^::ffff:/, "")
    const a = parseAnnouncement(buf, ip, { simulate: cfg.simulate })
    if (!a) return
    if (collector) {
      // Bounded: a flood of spoofed MACs cannot grow the run (or its enrichment) without limit.
      const key = a.mac ?? a.ip
      if (collector.found.has(key) || collector.found.size < timing.maxReplies) collector.found.set(key, a)
      else collector.dropped++
      return
    }
    // A passive announcement never triggers a probe.
    known.upsert(fromAnnouncement(a, { reachable: isEnrichable(a.ip, lanInterfaces(ifaces()), cfg.broadcastTargets) }), "udp-passive")
  }

  function onMessage(msg: Buffer, rinfo: dgram.RemoteInfo): void {
    try {
      ingest(msg, rinfo.address)
    } catch (err) {
      log.error("Error al procesar un anuncio UDP", { err })
    }
  }

  async function runUdp(actor: ActorRef): Promise<RelayDiscoveryResultDTO> {
    const startedAt = now()
    const runId = crypto.randomUUID()
    const lan = lanInterfaces(ifaces())
    const warnings: string[] = []
    const requested = cfg.broadcastTargets ?? lan.map((i) => i.broadcast)
    // D21: never the limited broadcast 255.255.255.255.
    const targets = [...new Set(requested.filter((t) => t !== "255.255.255.255"))]
    if (!targets.length) warnings.push(RELAY_TEXT.warnNoTargets)
    let sock = passive
    let temp: dgram.Socket | null = null
    const run = { found: new Map<string, Announcement>(), dropped: 0 }
    const found = run.found
    if (targets.length) {
      if (!sock) {
        try {
          temp = await bindUdp(createSocket, cfg.discoveryPort)
          temp.on("message", onMessage)
          temp.on("error", (err) => log.warn("Error en el socket UDP temporal", { error: err.message }))
          sock = temp
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code ?? "ERROR"
          warnings.push(`${code}: ${RELAY_TEXT.warnUdpUnavailable}`)
        }
      }
      if (sock) {
        collector = run
        try {
          for (let k = 0; k < timing.repeats; k++) {
            for (const t of targets) {
              const err = await sendDatagram(sock, DISCOVERY_REQUEST, cfg.discoveryPort, t)
              if (err) {
                const w = RELAY_TEXT.warnSend(err.code ?? "ERROR", t)
                if (!warnings.includes(w)) warnings.push(w)
              }
            }
            if (k < timing.repeats - 1) await abortableSleep(timing.intervalMs, life.signal)
          }
          await abortableSleep(timing.collectMs, life.signal)
        } catch {
          // stopping: return what was collected
        } finally {
          collector = null
          if (temp) await closeUdp(temp)
        }
      }
    }

    if (run.dropped > 0) warnings.push(RELAY_TEXT.warnUdpRepliesDropped(run.dropped, timing.maxReplies))

    // Enrichment: read-only autodetect, only for IPs inside a LAN subnet or a broadcast-target network, once per IP
    // (several MACs answering from one source address share the probe).
    const boards: DiscoveredBoardDTO[] = []
    const detectByIp = new Map<string, Promise<DetectResultDTO[]>>()
    const detectOnce = (a: Announcement): Promise<DetectResultDTO[]> => {
      let p = detectByIp.get(a.ip)
      if (!p) {
        // withOpSignal, never AbortSignal.any with the long-lived life.signal (leaks; see op-signal.ts).
        p = withOpSignal(life.signal, 15_000, (signal) => deps.registry.autodetect(a.ip, { httpPort: a.httpPort ?? 80, tcpPort: a.tcpPort }, {
          signal, timeoutMs: cfg.timeoutMs,
          hint: { mac: a.mac, hostname: a.hostname, model: a.model, moduleId: a.moduleId },
        })).catch((): DetectResultDTO[] => [])
        detectByIp.set(a.ip, p)
      }
      return p
    }
    await pool([...found.values()], timing.enrichConcurrency, life.signal, async (a) => {
      let update: KnownUpdate
      if (isEnrichable(a.ip, lan, cfg.broadcastTargets)) {
        const res = await detectOnce(a)
        const best = res[0] ?? null
        update = fromAnnouncement(a, {
          detect: best, reachable: best !== null,
          hints: [...a.hints, ...(best ? [] : [RELAY_TEXT.hintUnreachable])],
          model: a.model ?? best?.model ?? null,
        })
      } else {
        update = fromAnnouncement(a, { detect: null, reachable: false, hints: [...a.hints, RELAY_TEXT.hintNotProbed] })
      }
      boards.push(known.upsert(update, "udp-active"))
    })
    const result: RelayDiscoveryResultDTO = {
      runId, kind: "udp", startedAt: startedAt.toISOString(), finishedAt: now().toISOString(), targets,
      boards: dedupe(boards), warnings,
    }
    deps.audit.record({ actor, action: "discovery.relay.udp", target: { type: "discovery", id: runId, name: "UDP" }, detail: { targets, found: result.boards.length } })
    return result
  }

  /** The CIDRs and ports a scan will actually use (input, then configuration, then the LAN defaults). */
  function scanPlan(input: RelayScanInput): { cidrs: string[]; ports: number[] } {
    return { cidrs: input.cidrs ?? cfg.scanCidrs ?? defaultScanCidrs(lanInterfaces(ifaces())), ports: input.ports ?? cfg.scanPorts }
  }

  async function runScan(plan: { cidrs: string[]; ports: number[] }, actor: ActorRef): Promise<RelayDiscoveryResultDTO> {
    const startedAt = now()
    const runId = crypto.randomUUID()
    const osIfaces = ifaces()
    const { cidrs, ports } = plan
    const warnings: string[] = []
    if (!cidrs.length) warnings.push(RELAY_TEXT.warnNoCidrs)
    let hosts: string[]
    try {
      const r = expandScanTargets(cidrs, { ownIps: ownAddresses(osIfaces) })
      hosts = r.hosts
      if (r.truncated) warnings.push(RELAY_TEXT.warnScanTruncated(hosts.length))
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      throw new DomainError("VALIDATION", msg, { cidrs: [msg] })
    }
    const jobs = hosts.flatMap((h) => ports.map((p) => ({ host: h, port: p })))
    const total = jobs.length
    let done = 0
    const progress = () => deps.bus.publish({ type: "discovery.progress", runId, done, total }, { kind: "admins" })
    progress()
    const timer = setInterval(progress, timing.progressMs)
    timer.unref()
    const hits: ScanHit[] = []
    const scanDeps = { registry: deps.registry, probe, timeoutMs: cfg.timeoutMs, connectTimeoutMs: timing.connectTimeoutMs, tcpPorts: scanPorts }
    try {
      await pool(jobs, timing.scanConcurrency, life.signal, async (j) => {
        try {
          const hit = await probeHost(j.host, j.port, scanDeps, life.signal)
          if (hit) hits.push(hit)
        } catch (err) {
          log.warn("Error al sondear una dirección", { destino: j.host, puerto: j.port, error: String(err) })
        } finally {
          done++
        }
      })
    } finally {
      clearInterval(timer)
      progress()
    }
    const boards = dedupe(hits.map((h) => known.upsert({
      ip: h.ip, httpPort: h.httpPort, detect: h.detect, reachable: true, model: h.detect.model, moduleId: h.detect.moduleId,
      tcpPort: h.detect.tcpPort, hostname: h.detect.hostname, mac: h.detect.mac,
    }, "scan")))
    const result: RelayDiscoveryResultDTO = {
      runId, kind: "scan", startedAt: startedAt.toISOString(), finishedAt: now().toISOString(), targets: cidrs, boards, warnings,
    }
    deps.audit.record({
      actor, action: "discovery.relay.scan", target: { type: "discovery", id: runId, name: cidrs.join(", ") },
      detail: { cidrs, ports, hosts: hosts.length, found: boards.length },
    })
    return result
  }

  function dedupe(list: DiscoveredBoardDTO[]): DiscoveredBoardDTO[] {
    const byKey = new Map<string, DiscoveredBoardDTO>()
    for (const b of list) byKey.set(b.key, b)
    return [...byKey.keys()].map((k) => known.find(k) ?? (byKey.get(k) as DiscoveredBoardDTO))
  }

  return {
    known: () => known.list(),
    find: (key) => known.find(key),
    listening: () => passive !== null,
    trafficExceeded: () => limiter.exceededWithin(60_000),
    ingest,

    discoverUdp(actor) {
      // One run at a time: a second click while running gets the same result.
      if (!udpRun) udpRun = runUdp(actor).finally(() => { udpRun = null })
      return udpRun
    },
    scan(input, actor) {
      // One scan at a time. The same request while it runs shares its result; a different one is refused, so a
      // caller never gets the result of other networks or ports.
      const plan = scanPlan(input)
      const key = JSON.stringify(plan)
      if (scanRun) {
        return scanRun.key === key ? scanRun.promise : Promise.reject(new DomainError("CONFLICT", RELAY_TEXT.errScanRunning))
      }
      const promise = runScan(plan, actor).finally(() => { if (scanRun?.promise === promise) scanRun = null })
      scanRun = { key, promise }
      return promise
    },

    async start() {
      if (!cfg.passiveDiscovery || passive) return
      try {
        const s = await bindUdp(createSocket, cfg.discoveryPort)
        s.on("message", onMessage)
        s.on("error", (err) => {
          log.warn(RELAY_TEXT.logPassiveBindError, { error: err.message })
          if (passive === s) passive = null
          void closeUdp(s)
        })
        passive = s
        log.info(RELAY_TEXT.logPassiveBound, { puerto: cfg.discoveryPort })
      } catch (e) {
        log.warn(RELAY_TEXT.logPassiveBindError, { puerto: cfg.discoveryPort, error: e instanceof Error ? e.message : String(e) })
      }
    },
    async stop() {
      life.abort()
      const s = passive
      passive = null
      if (s) await closeUdp(s)
      await Promise.allSettled([udpRun, scanRun?.promise ?? null].filter((p): p is Promise<RelayDiscoveryResultDTO> => p !== null))
    },
  }
}
