// Serial services (W1-A, §4.4–§4.7, §5): discovery, console manager with continuous capture, probe, preview, WS.
import type { MatchBy } from "@/lib/contracts/enums"
import type { SerialPortDTO, SerialSnapshotDTO, UsbAdapterDTO } from "@/lib/contracts/serial"
import { WS_CLOSE } from "@/lib/contracts/ws"
import { SERIAL_LOG, serialChangeLabel, WS_REASON } from "@/lib/i18n/serial"
import type { SerialDeps, SerialServices } from "@/server/runtime/types"
import { createCaptureService } from "./capture/service"
import type { StatfsLike } from "./capture/retention"
import { ConsoleManagerImpl, type PortUsage } from "./console-manager"
import { createDescribeCache, scanSerialPorts, type SerialDevice } from "./enumerate"
import type { UsbSerialAdapter } from "./group"
import { bindingFromDevice, letterOf } from "./matcher"
import { extraGlobDirs } from "./paths"
import { createPortOpener, type PortOpener } from "./port-factory"
import { PreviewManager } from "./preview"
import { createProbeService } from "./probe"
import { SerialDiscoveryImpl, type DiscoveryEvent, type WatchFn } from "./watcher"
import { createWsHandler } from "./ws"

/** Test seams (the frozen factory signature is `createSerialServices(deps)`; these are optional internals). */
export interface SerialInternals {
  openPort?: PortOpener
  scan?: () => Promise<SerialDevice[]>
  watch?: WatchFn
  statfs?: (dir: string) => Promise<StatfsLike>
  handshakeTimeoutMs?: number
  backoffMs?: readonly number[]
  minuteMs?: number
  probeTimings?: { pokeListenMs?: number; pokeAfterMs?: number; bootExtraMs?: number }
  /** Open deadline for consoles, previews and probes (default 10 s). */
  openTimeoutMs?: number
  /** How long a preview port stays open after its last viewer leaves (default 5 s, §4.7). */
  previewGraceMs?: number
}

export function createSerialServices(deps: SerialDeps, internals: SerialInternals = {}): SerialServices {
  const cfg = deps.config
  const log = deps.log.child("serial")
  const usage: PortUsage = { busy: new Set() }
  const openPort = internals.openPort ?? createPortOpener()
  const cache = createDescribeCache()
  const scan = internals.scan ?? (() => scanSerialPorts({
    sysRoot: cfg.serial.sysRoot, devRoot: cfg.serial.devRoot, extraGlobs: cfg.serial.extraGlobs, includeBuiltin: cfg.serial.includeBuiltin, cache,
  }))

  let pending: Promise<void> = Promise.resolve()
  const watcher = new SerialDiscoveryImpl({
    scan,
    devRoot: cfg.serial.devRoot,
    extraDirs: extraGlobDirs(cfg.serial.extraGlobs, cfg.serial.devRoot),
    intervalMs: cfg.serial.scanIntervalMs,
    settleMs: cfg.serial.settleMs,
    watch: internals.watch,
    log,
    onChange: (events) => { pending = pending.then(() => onDiscovery(events)) },
  })
  const capture = createCaptureService({
    captureDir: cfg.captureDir, enabled: cfg.capture.enabled, settings: deps.settings, audit: deps.audit, log: deps.log, statfs: internals.statfs,
  })
  // The preview asks the manager who holds a port; the manager closes previews on bind: they reference each other.
  const holder: { manager: ConsoleManagerImpl | null } = { manager: null }
  const previews = new PreviewManager({
    discovery: watcher, openPort, usage, audit: deps.audit, log: deps.log, openTimeoutMs: internals.openTimeoutMs,
    graceMs: internals.previewGraceMs,
    claim: (key) => (holder.manager?.isBound(key) ? "bound" : holder.manager?.isHeldOpen(key) ? "held" : null),
  })
  const manager = new ConsoleManagerImpl({
    prisma: deps.prisma, bus: deps.bus, audit: deps.audit, settings: deps.settings, log: deps.log, config: cfg,
    reservations: deps.reservations, discovery: watcher, capture, openPort, previews, usage,
    backoffMs: internals.backoffMs, minuteMs: internals.minuteMs, openTimeoutMs: internals.openTimeoutMs,
  })
  holder.manager = manager
  const probe = createProbeService({
    discovery: watcher, openPort, audit: deps.audit, log: deps.log, usage,
    held: { history: (k) => manager.heldHistory(k) ?? previews.buffer(k), isBound: (k) => manager.isBound(k) },
    allowPoke: () => cfg.serial.allowPoke,
    timings: internals.probeTimings, openTimeoutMs: internals.openTimeoutMs,
  })
  const ws = createWsHandler({
    prisma: deps.prisma, bus: deps.bus, audit: deps.audit, log: deps.log, sessions: deps.sessions, authenticate: deps.authenticate,
    manager, previews, handshakeTimeoutMs: internals.handshakeTimeoutMs,
  })

  function portDTO(d: SerialDevice): SerialPortDTO {
    const held = manager.isHeldOpen(d.stableKey) || previews.isOpen(d.stableKey)
    const u = d.usb
    return {
      stableKey: d.stableKey, name: d.name, devNode: d.devNode, kind: d.kind, driver: d.driver,
      byId: d.byId[0] ?? null, byPath: d.byPath[0] ?? null,
      usb: u ? {
        vendorId: u.vendorId, productId: u.productId, manufacturer: u.manufacturer, product: u.product, serial: u.serial,
        interfaceNumber: u.interfaceNumber, interfaceName: u.interfaceName, portNumber: u.portNumber, idPath: u.idPath,
        portPath: u.portPath, busnum: u.busnum, devnum: u.devnum,
      } : null,
      interfaceLetter: letterOf(d),
      accessible: d.accessible, accessError: d.accessError, hints: [...d.hints],
      assignment: manager.assignmentFor(d.stableKey),
      inUse: held ? "app" : usage.busy.has(d.stableKey) ? "other" : null,
    }
  }

  let labelOf: ((identity: string) => string | null) | null = null
  function adapterDTO(a: UsbSerialAdapter): UsbAdapterDTO {
    const labelName = labelOf ? labelOf(a.identityKey ?? `loc:${a.locationKey}`) : null
    return {
      locationKey: a.locationKey, identityKey: a.identityKey, vendorId: a.vendorId, productId: a.productId,
      manufacturer: a.manufacturer, product: a.product, serial: a.serial, label: labelName ? `${labelName} · ${a.label}` : a.label, labelName, location: a.location,
      hints: [...a.hints], ports: a.ports.map(portDTO),
    }
  }

  function toDTO(): SerialSnapshotDTO {
    const adapters = watcher.adapters()
    return {
      scannedAt: watcher.scannedAt().toISOString(),
      adapters: adapters.map(adapterDTO),
      others: watcher.others().map(portDTO),
      hiddenJtag: cfg.serial.hideJtag ? adapters.filter((a) => a.hints.includes("jtag-probable")).length : 0,
      watcher: { inotify: watcher.inotify(), intervalMs: cfg.serial.scanIntervalMs },
    }
  }

  /** After a discovery event: re-resolve every console (auto re-acquire), then tell the admins. */
  async function onDiscovery(events: DiscoveryEvent[]): Promise<void> {
    try {
      for (const e of events) {
        if (e.kind === "adapter-removed") for (const p of e.adapter?.ports ?? []) usage.busy.delete(p.stableKey)
        if (e.kind === "port-removed" && e.port) usage.busy.delete(e.port.stableKey)
      }
      await manager.onDiscoveryChange()
      const snapshot = toDTO()
      for (const e of events) {
        log.info(SERIAL_LOG.discovery, { cambio: e.label })
        deps.bus.publish({ type: "serial.changed", snapshot, change: { kind: e.kind, label: e.label } }, { kind: "admins" })
      }
    } catch (err) {
      log.error("Error al aplicar un cambio de puertos serie", { err })
    }
  }

  return {
    discovery: {
      toDTO,
      async rescan(actor) {
        await watcher.scanNow()
        await pending
        await manager.onDiscoveryChange()
        const snapshot = toDTO()
        deps.bus.publish({ type: "serial.changed", snapshot, change: { kind: "rescan", label: serialChangeLabel.rescan } }, { kind: "admins" })
        deps.audit.record({
          actor: { kind: actor.kind, id: actor.id, name: actor.name, ip: actor.ip ?? null }, action: "discovery.serial.rescan", target: { type: "discovery" },
          detail: { adapters: snapshot.adapters.length, others: snapshot.others.length },
        })
        return snapshot
      },
      bindingFor(stableKey: string, matchBy: MatchBy | null) {
        const d = watcher.find(stableKey)
        return d ? bindingFromDevice(d, matchBy) : null
      },
      unassignedCount() {
        let n = 0
        for (const d of watcher.devices()) {
          if (cfg.serial.hideJtag && d.hints.includes("jtag-probable")) continue
          if (!manager.assignmentFor(d.stableKey)) n++
        }
        return n
      },
    },
    consoles: manager,
    probe,
    handleUpgrade: (req, socket, head, target) => ws.handleUpgrade(req, socket, head, target),
    setAdapterLabels(lookup) { labelOf = lookup },
    stats() {
      const s = manager.stats()
      return {
        openConsoles: s.openConsoles, problemConsoles: s.problemConsoles, wsSessions: ws.count(), inotify: watcher.inotify(),
        capture: { state: capture.state(), totalBytes: capture.totalBytes(), lastPurgeAt: capture.lastPurgeAt() },
      }
    },
    async start() {
      await watcher.start()
      await capture.start()
      capture.onStateChange(() => manager.republishAll())
      await manager.start()
      const snap = toDTO()
      log.info("Puertos serie detectados", {
        adaptadores: snap.adapters.length, otros: snap.others.length, consolasAbiertas: manager.stats().openConsoles,
        inotify: watcher.inotify(), captura: capture.state(),
      })
    },
    async stop() {
      await ws.closeAll(WS_CLOSE.GOING_AWAY, WS_REASON.shutdown)
      ws.stop()
      watcher.stop()
      await manager.stop()
      await capture.stop()
    },
  }
}
