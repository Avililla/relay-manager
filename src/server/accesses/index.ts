// Access services ("Accesos", Graph A, rt.accesses): per equipment, fixed TCP ports for JTAG (one supervised hw_server
// per cable), serial consoles over raw TCP (bridged into the console manager) and TCP forwards (Ethernet). Opened and
// closed by policy (only while reserved, or always), cable presence and configuration; audited; live status on the bus.
// Also the JTAG cable watcher and the cable label cache ("Cables").
import { dropCaps } from "@/server/caps"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import type { spawn as nodeSpawn } from "node:child_process"
import {
  AccessKindSchema, AccessPolicySchema, CableSerialSchema, type AccessConnectionDTO, type AccessKind, type AccessPolicy, type AccessRuntimeDTO,
  type AccessSettingsDTO, type AccessStatus, type AccessStopReason, type CableAssignmentDTO, type CableKind, type CableLabelDTO,
  type HwServerInfoDTO, type JtagCableDTO, type JtagSnapshotDTO,
} from "@/lib/contracts/accesses"
import type { ServerEvent } from "@/lib/contracts/events"
import { adapterIdentity } from "@/lib/accesses/labels"
import { accessDetail, accessLog, accessNotice, jtagChangeLabel } from "@/lib/i18n/accesses"
import type { Logger } from "@/server/log"
import type {
  AccessServices, ActorRef, AuditInput, EquipnetServices, ReservationChange, ServiceDeps, ReservationService, SerialServices,
} from "@/server/runtime/types"
import { SYSTEM_ACTOR } from "@/server/runtime/types"
import { findHwServer, hwServerArgs, hwServerFilter, isNodeScript, nodeHwServerFs, parseHwServerVersion } from "./hw-server"
import { scanJtagCables, type JtagCable } from "./jtag-enumerate"
import { PortBusyError } from "./listener"
import { establishedTo, readProcNetTcp } from "./proc-net"
import { SerialBridge } from "./serial-bridge"
import { ProcessSupervisor, tcpReady, type SupervisorState } from "./supervisor"
import { probeTarget, TcpForward } from "./tcp-forward"

export interface AccessDeps extends ServiceDeps {
  reservations: ReservationService
  serial: SerialServices
  equipnet: EquipnetServices
}

/** Test seams. */
export interface AccessInternals {
  scanJtag?: () => Promise<JtagCable[]>
  hwServer?: () => HwServerInfoDTO
  spawn?: typeof nodeSpawn
  procNet?: () => Promise<{ tcp4: string; tcp6: string }>
  jtagPollMs?: number
  connPollMs?: number
  retryMs?: number
  targetProbeMs?: number
  supervisor?: { startTimeoutMs?: number; backoffMs?: readonly number[]; killGraceMs?: number; pollMs?: number }
}

interface AccessRow {
  id: string; equipmentId: string; equipmentName: string; position: number
  key: string; label: string; kind: AccessKind; port: number; enabled: boolean; policy: AccessPolicy
  cableSerial: string | null; consoleId: string | null; consoleKey: string | null
  targetHost: string | null; targetPort: number | null
  targetMode: "ip" | "switch"; switchPort: number | null
}

interface AccessState {
  row: AccessRow
  status: AccessStatus
  reason: AccessStopReason
  detail: string | null
  since: Date
  sup: ProcessSupervisor | null
  supKey: string | null
  bridge: SerialBridge | null
  fwd: TcpForward | null
  /** Where the running forward goes (host, port, source): a change restarts it. */
  fwdKey: string | null
  targetReachable: boolean | null
  lastProbe: number
  jtagPeers: Map<string, Date>
  queue: Promise<void>
  retryTimer: NodeJS.Timeout | null
  lastPublished: string
  deleted: boolean
}

const DETAIL_ACTOR = (ip: string | null): ActorRef => ({ kind: "system", id: null, name: "cliente TCP", ip })
const AUDIT_WINDOW_MS = 60_000
const AUDIT_BURST = 20
const CONFIG_FIELDS = ["kind", "port", "enabled", "policy", "cableSerial", "consoleId", "targetHost", "targetPort", "targetMode", "switchPort"] as const

function reachHost(bind: string): string {
  return bind === "0.0.0.0" || bind === "::" ? "127.0.0.1" : bind
}

export function createAccessServices(deps: AccessDeps, internals: AccessInternals = {}): AccessServices {
  const cfg = deps.config
  const log: Logger = deps.log.child("accesos")
  const jtagLog = deps.log.child("jtag")
  const states = new Map<string, AccessState>()
  const scanJtag = internals.scanJtag ?? (() => scanJtagCables(cfg.accesses.jtagSysRoot))
  const hwFs = nodeHwServerFs()
  const detectHwServer = internals.hwServer ?? (() => findHwServer({
    explicit: cfg.accesses.hwServer, env: process.env, home: os.homedir() || null, fs: hwFs,
  }))
  const procNet = internals.procNet ?? readProcNetTcp
  const retryMs = internals.retryMs ?? 10_000
  const pidDir = path.join(cfg.dataDir, "run")
  const xilinxHome = path.join(cfg.dataDir, "xilinx")

  let hw: HwServerInfoDTO = { path: null, version: null, source: null, problem: null }
  let cables: JtagCable[] = []
  let scannedAt = new Date()
  let labelRows: Array<{ id: string; kind: CableKind; identity: string; name: string; notes: string | null; vendorId: string | null
    productId: string | null; product: string | null; firstSeenAt: Date; lastSeenAt: Date | null }> = []
  let stopped = true
  let jtagTimer: NodeJS.Timeout | null = null
  let connTimer: NodeJS.Timeout | null = null
  let unsubscribeRes: (() => void) | null = null
  let unsubscribeBus: (() => void) | null = null
  let unsubscribeNet: (() => void) | null = null
  let scanning: Promise<void> = Promise.resolve()
  const auditWindows = new Map<string, { start: number; n: number; dropped: number }>()

  // --- helpers --------------------------------------------------------------------------------------------------

  const audit = (st: AccessState, action: AuditInput["action"], detail: AuditInput["detail"], actor: ActorRef = SYSTEM_ACTOR, outcome: AuditInput["outcome"] = "ok") => {
    deps.audit.record({
      actor, action, outcome, equipment: { id: st.row.equipmentId, name: st.row.equipmentName },
      target: { type: "access", id: st.row.id, name: st.row.key }, detail: { port: st.row.port, kind: st.row.kind, ...(detail ?? {}) },
    })
  }

  const labelName = (kind: CableKind, identity: string | null): string | null =>
    identity ? labelRows.find((l) => l.kind === kind && l.identity === identity)?.name ?? null : null

  const cablePresent = (serial: string) => cables.some((c) => c.serial === serial)
  const reserved = (equipmentId: string) => deps.reservations.get(equipmentId) !== null

  function connections(st: AccessState): AccessConnectionDTO[] {
    if (st.bridge) return st.bridge.connections()
    if (st.fwd) return st.fwd.connections()
    return [...st.jtagPeers].map(([remote, since], i) => ({ id: `j${i}`, remote, since: since.toISOString(), rxBytes: null, txBytes: null }))
  }

  function runtimeOf(st: AccessState): AccessRuntimeDTO {
    return {
      status: st.status, reason: st.reason, detail: st.detail, since: st.since.toISOString(),
      connections: connections(st),
      writable: st.row.kind === "serial" && st.status === "listening" && reserved(st.row.equipmentId)
        && deps.serial.consoles.runtime(st.row.consoleId ?? "")?.status === "open",
      targetReachable: st.row.kind === "tcp" ? st.targetReachable : null,
      pid: st.sup?.pid ?? null,
      network: networkOf(st.row),
    }
  }

  /** Ethernet through the equipment switch: where the forward goes and how ("Red de equipos"). */
  function tcpTarget(r: AccessRow): { host: string; port: number; localAddress: string | null; bindError: string | null } | null {
    if (r.targetMode !== "switch") return r.targetHost && r.targetPort ? { host: r.targetHost, port: r.targetPort, localAddress: null, bindError: null } : null
    if (r.switchPort === null) return null
    const route = deps.equipnet.route(r.switchPort)
    const host = r.targetHost ?? route.equipmentIp
    return host && r.targetPort ? { host, port: r.targetPort, localAddress: route.localAddress, bindError: accessDetail.vlanGone(r.switchPort, route.localAddress ?? "") } : null
  }
  function networkOf(r: AccessRow): AccessRuntimeDTO["network"] {
    if (r.kind !== "tcp" || r.targetMode !== "switch" || r.switchPort === null) return null
    const route = deps.equipnet.route(r.switchPort)
    const t = tcpTarget(r)
    return { switchPort: r.switchPort, vid: route.vid, link: route.link, target: t ? `${t.host}:${t.port}` : null, ready: route.ready }
  }

  function publish(st: AccessState, force = false): void {
    if (st.deleted) return
    const runtime = runtimeOf(st)
    const key = JSON.stringify({ ...runtime, connections: runtime.connections.map((c) => [c.id, c.rxBytes, c.txBytes]) })
    if (!force && key === st.lastPublished) return
    st.lastPublished = key
    deps.bus.publish({ type: "access.status", equipmentId: st.row.equipmentId, accessId: st.row.id, runtime }, { kind: "equipment", equipmentId: st.row.equipmentId })
  }

  function setStatus(st: AccessState, status: AccessStatus, reason: AccessStopReason, detail: string | null): void {
    const was = st.status
    if (was !== status) st.since = new Date()
    st.status = status
    st.reason = reason
    st.detail = detail
    if (was !== status) {
      if (status === "listening") {
        log.info(accessLog.started, { equipo: st.row.equipmentName, acceso: st.row.key, puerto: st.row.port })
        audit(st, "access.start", {
          policy: st.row.policy,
          ...(st.row.kind === "jtag" && st.row.cableSerial ? { cable: st.row.cableSerial, cableName: labelName("jtag", st.row.cableSerial) } : {}),
          ...(st.row.kind === "tcp" ? { target: `${st.row.targetHost ?? ""}:${st.row.targetPort ?? ""}` } : {}),
        })
      } else if (was === "listening" || was === "starting") {
        log.info(accessLog.stopped, { equipo: st.row.equipmentName, acceso: st.row.key, puerto: st.row.port, estado: status })
        audit(st, "access.stop", { status, reason: reason ?? null })
      }
      if (status === "error" || status === "port-busy") {
        log.warn(accessLog.failed, { equipo: st.row.equipmentName, acceso: st.row.key, puerto: st.row.port, causa: detail ?? status })
        audit(st, "access.error", { status, detail: detail ?? null }, SYSTEM_ACTOR, "error")
      }
    }
    publish(st)
  }

  function enqueue(st: AccessState, fn: () => Promise<void>): Promise<void> {
    const run = st.queue.then(fn)
    st.queue = run.catch((err: unknown) => log.error("Error en la gestión de un acceso", { acceso: st.row.key, err }))
    return st.queue
  }

  function clearRetry(st: AccessState): void {
    if (st.retryTimer) clearTimeout(st.retryTimer)
    st.retryTimer = null
  }
  function scheduleRetry(st: AccessState): void {
    clearRetry(st)
    if (stopped || st.deleted) return
    st.retryTimer = setTimeout(() => {
      st.retryTimer = null
      void enqueue(st, () => evaluate(st))
    }, retryMs)
    st.retryTimer.unref()
  }

  async function stopComponents(st: AccessState, notice: string | null): Promise<void> {
    clearRetry(st)
    const { sup, bridge, fwd } = st
    st.sup = null
    st.supKey = null
    st.bridge = null
    st.fwd = null
    st.fwdKey = null
    st.jtagPeers.clear()
    if (sup) {
      await sup.stop()
      fs.rmSync(path.join(pidDir, `hw_server-${st.row.port}.pid`), { force: true })
    }
    if (bridge) await bridge.close(notice ?? undefined)
    if (fwd) await fwd.close()
  }

  /** Can this port be listened on right now (by us)? */
  async function portFree(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const s = net.createServer()
      s.once("error", () => resolve(false))
      s.listen({ port, host: cfg.accesses.bind, exclusive: true }, () => s.close(() => resolve(true)))
    })
  }

  // --- evaluate: what should this access be now, and make it so ---------------------------------------------------

  /** What keeps this access from opening, whatever the reservation (shown even while closed). */
  function blocker(st: AccessState): { status: AccessStatus; detail: string | null; notice: string | null } | null {
    const r = st.row
    // Only RM_ACCESS_PORTS is open in the lab firewall (and the web owns RM_PORT): e.g. the range changed after creation.
    const range = cfg.accesses.range
    if (r.port < range.from || r.port > range.to || r.port === cfg.port) {
      return { status: "error", detail: accessDetail.portOutsideRange(r.port, range.from, range.to), notice: accessNotice.disabledClose }
    }
    if (r.kind === "jtag") {
      if (!r.cableSerial) return { status: "unconfigured", detail: accessDetail.noCable, notice: null }
      if (!hw.path) return { status: "hw-server-missing", detail: hw.problem, notice: null }
      if (!cablePresent(r.cableSerial)) return { status: "cable-missing", detail: accessDetail.cableMissing(labelName("jtag", r.cableSerial) ?? r.cableSerial), notice: null }
      return null
    }
    if (r.kind === "serial") {
      if (!r.consoleId) return { status: "unconfigured", detail: accessDetail.noConsole, notice: accessNotice.disabledClose }
      if (!deps.serial.consoles.runtime(r.consoleId)) return { status: "console-missing", detail: accessDetail.consoleMissing, notice: accessNotice.consoleGone }
      return null
    }
    if (r.targetMode === "switch") {
      if (r.switchPort === null) return { status: "unconfigured", detail: accessDetail.noSwitchPort, notice: null }
      const route = deps.equipnet.route(r.switchPort)
      if (!route.configured || !route.ready || !route.localAddress) {
        return { status: "network-missing", detail: accessDetail.networkMissing(route.problem ?? "la VLAN de este puerto no está preparada en el servidor"), notice: accessNotice.disabledClose }
      }
      if (!r.targetPort) return { status: "unconfigured", detail: accessDetail.noTarget, notice: null }
      return null
    }
    if (!r.targetHost || !r.targetPort) return { status: "unconfigured", detail: accessDetail.noTarget, notice: null }
    return null
  }

  async function evaluate(st: AccessState): Promise<void> {
    if (st.deleted || stopped) return
    const r = st.row
    if (!r.enabled) {
      await stopComponents(st, accessNotice.disabledClose)
      return setStatus(st, "stopped", "disabled", accessDetail.disabled)
    }
    const b = blocker(st)
    if (b) {
      await stopComponents(st, b.notice)
      return setStatus(st, b.status, null, b.detail)
    }
    if (r.policy === "reserved" && !reserved(r.equipmentId)) {
      await stopComponents(st, accessNotice.releasedClose)
      return setStatus(st, "stopped", "not-reserved", accessDetail.notReserved)
    }
    if (r.kind === "jtag") return evaluateJtag(st)
    if (r.kind === "serial") return evaluateSerial(st)
    return evaluateTcp(st)
  }

  async function evaluateJtag(st: AccessState): Promise<void> {
    const r = st.row
    const hwPath = hw.path
    if (!r.cableSerial || !hwPath) return
    // The filter goes into hw_server's -e (a Tcl command line): only a plain serial, never an injected command.
    if (!CableSerialSchema.safeParse(r.cableSerial).success) {
      await stopComponents(st, null)
      return setStatus(st, "error", null, accessDetail.badCableSerial(r.cableSerial))
    }
    const cable = cables.find((c) => c.serial === r.cableSerial)
    const filter = hwServerFilter(cfg.accesses.hwServerFilter, { serial: r.cableSerial, family: cable?.family ?? null })
    const args = hwServerArgs({ bind: cfg.accesses.bind, port: r.port, cableSerial: r.cableSerial, filter })
    const supKey = JSON.stringify([hwPath, args])
    if (st.sup && st.supKey === supKey) return
    await stopComponents(st, null)
    if (!(await portFree(r.port))) {
      setStatus(st, "port-busy", null, accessDetail.portBusy(r.port))
      return scheduleRetry(st)
    }
    fs.mkdirSync(path.join(xilinxHome, "tmp"), { recursive: true, mode: 0o750 })
    fs.mkdirSync(pidDir, { recursive: true, mode: 0o750 })
    const script = isNodeScript(hwPath)
    const file0 = script ? process.execPath : hwPath
    const args0 = script ? [hwPath, ...args] : args
    // "Red de equipos": the service may hold CAP_NET_ADMIN as an ambient capability, which children inherit.
    // hw_server does not need it: drop it with setpriv (util-linux) when that is the case.
    const setpriv = dropCaps()
    const sup = new ProcessSupervisor({
      command: {
        file: setpriv ?? file0,
        args: setpriv ? ["--inh-caps=-all", "--ambient-caps=-all", "--", file0, ...args0] : args0,
        env: { PATH: process.env.PATH ?? "/usr/sbin:/usr/bin:/sbin:/bin", HOME: xilinxHome, TMPDIR: path.join(xilinxHome, "tmp"), LANG: "C.UTF-8" },
        cwd: xilinxHome,
      },
      readiness: () => tcpReady(reachHost(cfg.accesses.bind), r.port),
      spawn: internals.spawn,
      ...internals.supervisor,
      onOutput: (line, stream) => {
        if (!hw.version) hw = { ...hw, version: parseHwServerVersion(line) ?? hw.version }
        jtagLog.info(line, { acceso: r.key, puerto: r.port, salida: stream })
      },
      onState: (s: SupervisorState) => {
        if (st.sup !== sup) return
        if (s.pid) {
          try { fs.writeFileSync(path.join(pidDir, `hw_server-${r.port}.pid`), `${s.pid}\n`, { mode: 0o640 }) } catch { /* informative */ }
        }
        if (s.state === "starting") setStatus(st, "starting", null, accessDetail.hwServerStarting)
        else if (s.state === "running") setStatus(st, "listening", null, null)
        else if (s.state === "backoff") setStatus(st, "error", null, accessDetail.hwServerFailed(s.detail ?? "terminó", s.retryInMs ? Math.round(s.retryInMs / 1000) : null))
      },
    })
    st.sup = sup
    st.supKey = supKey
    jtagLog.info("Arrancando hw_server", { acceso: r.key, equipo: r.equipmentName, orden: [hwPath, ...args].join(" ") })
    sup.start()
  }

  async function evaluateSerial(st: AccessState): Promise<void> {
    const r = st.row
    if (!r.consoleId) return
    if (st.bridge) {
      st.bridge.writableChanged()
      return setStatus(st, "listening", null, null)
    }
    const consoleId = r.consoleId
    const bridge = new SerialBridge({
      bind: cfg.accesses.bind, port: r.port, consoleId, source: deps.serial.consoles,
      maxConnections: cfg.accesses.maxConnections,
      writable: () => reserved(r.equipmentId),
      onInput: () => touchReservation(r.equipmentId),
      onEvent: (e) => onConnEvent(st, e),
    })
    try {
      await bridge.listen()
    } catch (err) {
      return listenFailed(st, err)
    }
    st.bridge = bridge
    setStatus(st, "listening", null, null)
  }

  async function evaluateTcp(st: AccessState): Promise<void> {
    const r = st.row
    const t = tcpTarget(r)
    if (!t) return
    const key = JSON.stringify(t)
    if (st.fwd && st.fwdKey === key) return setStatus(st, "listening", null, reachDetail(st))
    if (st.fwd) {
      await stopComponents(st, accessNotice.disabledClose)
      st.targetReachable = null
    }
    const { host, port, localAddress, bindError } = t
    let lastTouch = 0
    const fwd = new TcpForward({
      bind: cfg.accesses.bind, port: r.port, target: { host, port }, localAddress, bindError: bindError ?? undefined, maxConnections: cfg.accesses.maxConnections,
      onActivity: () => {
        const t = Date.now()
        if (t - lastTouch < 30_000) return
        lastTouch = t
        touchReservation(r.equipmentId)
      },
      onEvent: (e) => {
        if (e.kind === "target-error") {
          st.targetReachable = false
          // The VLAN address is gone (bind failed): say so, and let the equipment network notice it at once.
          setStatus(st, st.status, st.reason, bindError && e.error === bindError ? bindError : reachDetail(st))
          if (bindError && e.error === bindError) void deps.equipnet.reconcileNow(SYSTEM_ACTOR).catch(() => undefined)
          publish(st)
          return
        }
        if (e.kind === "connect" && st.targetReachable !== true) {
          st.targetReachable = true
          setStatus(st, st.status, st.reason, reachDetail(st))
        }
        onConnEvent(st, e)
      },
    })
    try {
      await fwd.listen()
    } catch (err) {
      return listenFailed(st, err)
    }
    st.fwd = fwd
    st.fwdKey = key
    setStatus(st, "listening", null, reachDetail(st))
    void probe(st)
  }

  function reachDetail(st: AccessState): string | null {
    const t = tcpTarget(st.row)
    return st.targetReachable === false && t ? accessDetail.targetUnreachable(`${t.host}:${t.port}`) : null
  }

  async function probe(st: AccessState): Promise<void> {
    const t = tcpTarget(st.row)
    if (!st.fwd || !t) return
    st.lastProbe = Date.now()
    const ok = await probeTarget(t.host, t.port, 2000, t.localAddress)
    if (!st.fwd || st.deleted) return
    st.targetReachable = ok
    if (st.status === "listening") setStatus(st, "listening", null, reachDetail(st))
  }

  function listenFailed(st: AccessState, err: unknown): void {
    if (err instanceof PortBusyError) setStatus(st, "port-busy", null, accessDetail.portBusy(st.row.port))
    else setStatus(st, "error", null, accessDetail.listenFailed(err instanceof Error ? err.message : String(err)))
    scheduleRetry(st)
  }

  /**
   * Connection audit rows per access and client IP: at most AUDIT_BURST a minute (anyone on the LAN can connect in a
   * loop). The rest are counted and summed up in the first row of the next minute.
   */
  function auditConn(st: AccessState, ip: string, action: AuditInput["action"], detail: NonNullable<AuditInput["detail"]>, outcome: AuditInput["outcome"] = "ok"): void {
    const key = `${st.row.id}|${ip}`
    const t = Date.now()
    let w = auditWindows.get(key)
    if (!w || t - w.start >= AUDIT_WINDOW_MS) {
      const dropped = w?.dropped ?? 0
      w = { start: t, n: 0, dropped: 0 }
      auditWindows.set(key, w)
      if (dropped) detail = { ...detail, suppressedBefore: dropped }
    }
    if (++w.n > AUDIT_BURST) {
      if (!w.dropped) log.warn("Demasiadas conexiones seguidas a un acceso: no se auditan todas", { equipo: st.row.equipmentName, acceso: st.row.key, desde: ip })
      w.dropped++
      return
    }
    audit(st, action, detail, DETAIL_ACTOR(ip), outcome)
  }

  function onConnEvent(st: AccessState, e: { kind: string; remote: string; rxBytes?: number; txBytes?: number; ms?: number; reason?: string }): void {
    const ip = e.remote.replace(/:\d+$/, "").replace(/^\[|\]$/g, "")
    if (e.kind === "connect") {
      log.info(accessLog.connected, { equipo: st.row.equipmentName, acceso: st.row.key, puerto: st.row.port, desde: e.remote })
      auditConn(st, ip, "access.connect", { remote: e.remote })
    } else if (e.kind === "close") {
      log.info(accessLog.disconnected, { equipo: st.row.equipmentName, acceso: st.row.key, desde: e.remote, bytes: (e.rxBytes ?? 0) + (e.txBytes ?? 0) })
      auditConn(st, ip, "access.disconnect", { remote: e.remote, rxBytes: e.rxBytes ?? 0, txBytes: e.txBytes ?? 0, seconds: Math.round((e.ms ?? 0) / 1000) })
    } else if (e.kind === "refused") {
      auditConn(st, ip, "access.connect", { remote: e.remote, reason: e.reason ?? "refused" }, "denied")
    }
    publish(st, true)
  }

  // --- rows -----------------------------------------------------------------------------------------------------

  async function loadRows(where: { equipmentId?: string }): Promise<AccessRow[]> {
    const rows = await deps.prisma.equipmentAccess.findMany({
      where,
      include: { equipment: { select: { name: true } }, console: { select: { key: true } } },
      orderBy: [{ equipmentId: "asc" }, { position: "asc" }],
    })
    return rows.flatMap((a) => {
      const kind = AccessKindSchema.safeParse(a.kind)
      const policy = AccessPolicySchema.safeParse(a.policy)
      if (!kind.success) {
        log.warn("Acceso con un tipo desconocido: se ignora", { acceso: a.key, tipo: a.kind })
        return []
      }
      return [{
        id: a.id, equipmentId: a.equipmentId, equipmentName: a.equipment.name, position: a.position, key: a.key, label: a.label,
        kind: kind.data, port: a.port, enabled: a.enabled, policy: policy.success ? policy.data : "reserved",
        cableSerial: a.jtagCableSerial, consoleId: a.consoleId, consoleKey: a.console?.key ?? null, targetHost: a.targetHost, targetPort: a.targetPort,
        targetMode: a.targetMode === "switch" ? "switch" as const : "ip" as const, switchPort: a.switchPort,
      }]
    })
  }

  function newState(row: AccessRow): AccessState {
    const st: AccessState = {
      row, status: "stopped", reason: null, detail: null, since: new Date(), sup: null, supKey: null, bridge: null, fwd: null, fwdKey: null,
      targetReachable: null, lastProbe: 0, jtagPeers: new Map(), queue: Promise.resolve(), retryTimer: null, lastPublished: "", deleted: false,
    }
    states.set(row.id, st)
    return st
  }

  async function upsert(row: AccessRow): Promise<void> {
    const st = states.get(row.id)
    if (!st) {
      const n = newState(row)
      await enqueue(n, () => evaluate(n))
      return
    }
    await enqueue(st, async () => {
      const changed = CONFIG_FIELDS.some((k) => st.row[k] !== row[k])
      st.row = row
      if (changed) {
        await stopComponents(st, accessNotice.disabledClose)
        st.targetReachable = null
      }
      await evaluate(st)
      publish(st, true)
    })
  }

  async function remove(st: AccessState): Promise<void> {
    await enqueue(st, async () => {
      st.deleted = true
      await stopComponents(st, accessNotice.disabledClose)
      if (st.status === "listening" || st.status === "starting") audit(st, "access.stop", { reason: "deleted" })
      states.delete(st.row.id)
    })
  }

  // --- JTAG cables and labels -----------------------------------------------------------------------------------

  function assignmentsFor(serial: string | null): CableAssignmentDTO[] {
    if (!serial) return []
    return [...states.values()].filter((s) => s.row.kind === "jtag" && s.row.cableSerial === serial)
      .map((s) => ({ equipmentId: s.row.equipmentId, equipmentName: s.row.equipmentName, id: s.row.id, key: s.row.key, label: s.row.label }))
  }

  function cableDTO(c: JtagCable): JtagCableDTO {
    const label = c.serial ? labelRows.find((l) => l.kind === "jtag" && l.identity === c.serial) : undefined
    return {
      serial: c.serial, vendorId: c.vendorId, productId: c.productId, manufacturer: c.manufacturer, product: c.product, family: c.family,
      location: c.location, labelId: label?.id ?? null, labelName: label?.name ?? null, assignedTo: assignmentsFor(c.serial),
    }
  }

  function jtagSnapshot(): JtagSnapshotDTO {
    return { scannedAt: scannedAt.toISOString(), cables: cables.map(cableDTO) }
  }

  function serialAssignments(): Map<string, { connected: true; assigned: CableAssignmentDTO[] }> {
    const out = new Map<string, { connected: true; assigned: CableAssignmentDTO[] }>()
    for (const a of deps.serial.discovery.toDTO().adapters) {
      const assigned: CableAssignmentDTO[] = []
      for (const p of a.ports) {
        if (p.assignment) assigned.push({ equipmentId: p.assignment.equipmentId, equipmentName: p.assignment.equipmentName, id: p.assignment.consoleId, key: p.assignment.consoleKey, label: p.assignment.consoleLabel })
      }
      out.set(adapterIdentity(a), { connected: true, assigned })
    }
    return out
  }

  function labelsDTO(): CableLabelDTO[] {
    const serial = serialAssignments()
    const nets = new Set(deps.equipnet.adapters().map((a) => a.mac))
    return labelRows.map((l) => {
      const connected = l.kind === "jtag" ? cablePresent(l.identity) : l.kind === "net-adapter" ? nets.has(l.identity) : serial.has(l.identity)
      const assignedTo = l.kind === "jtag" ? assignmentsFor(l.identity) : serial.get(l.identity)?.assigned ?? []
      return {
        id: l.id, kind: l.kind, identity: l.identity, name: l.name, notes: l.notes, vendorId: l.vendorId, productId: l.productId, product: l.product,
        firstSeenAt: l.firstSeenAt.toISOString(), lastSeenAt: l.lastSeenAt?.toISOString() ?? null, connected, assignedTo,
      }
    }).sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name, "es", { numeric: true }))
  }

  async function loadLabels(): Promise<void> {
    const rows = await deps.prisma.cableLabel.findMany()
    labelRows = rows.flatMap((r) => (r.kind === "jtag" || r.kind === "serial-adapter" || r.kind === "net-adapter" ? [{ ...r, kind: r.kind }] : []))
  }

  async function touchSeen(kind: CableKind, identities: string[]): Promise<void> {
    if (!identities.length) return
    const known = identities.filter((id) => labelRows.some((l) => l.kind === kind && l.identity === id))
    if (!known.length) return
    const now = new Date()
    try {
      await deps.prisma.cableLabel.updateMany({ where: { kind, identity: { in: known } }, data: { lastSeenAt: now } })
      for (const l of labelRows) if (l.kind === kind && known.includes(l.identity)) l.lastSeenAt = now
    } catch (err) {
      log.warn("No se pudo actualizar la última vez que se vio un cable", { error: String(err) })
    }
  }

  /** Cable snapshots and labels name every equipment that uses a cable: admins only (Cables, Sistema, editors). */
  function publishBus(event: ServerEvent): void {
    deps.bus.publish(event, { kind: "admins" })
  }

  async function rescan(reason: "poll" | "rescan"): Promise<void> {
    let next: JtagCable[]
    try {
      next = [...(await scanJtag())]
    } catch (err) {
      log.warn("No se pudieron enumerar los cables JTAG", { error: String(err) })
      return
    }
    const key = (c: JtagCable) => `${c.serial ?? ""}@${c.portPath}`
    const before = new Map(cables.map((c) => [key(c), c]))
    const after = new Map(next.map((c) => [key(c), c]))
    const added = next.filter((c) => !before.has(key(c)))
    const removed = cables.filter((c) => !after.has(key(c)))
    cables = next
    scannedAt = new Date()
    if (!added.length && !removed.length && reason === "poll") {
      // hw_server installed meanwhile?
      if (!hw.path && [...states.values()].some((s) => s.status === "hw-server-missing")) {
        hw = detectHwServer()
        if (hw.path) await reevaluate((s) => s.row.kind === "jtag")
      }
      return
    }
    const name = (c: JtagCable) => labelName("jtag", c.serial) ?? c.serial ?? c.product ?? c.location
    for (const c of added) log.info(accessLog.cableAdded, { cable: name(c), serie: c.serial ?? "", ubicacion: c.location })
    for (const c of removed) log.info(accessLog.cableRemoved, { cable: name(c), serie: c.serial ?? "" })
    await touchSeen("jtag", added.flatMap((c) => (c.serial ? [c.serial] : [])))
    const snapshot = jtagSnapshot()
    if (reason === "rescan") publishBus({ type: "jtag.changed", snapshot, change: { kind: "rescan", label: jtagChangeLabel.rescan } })
    for (const c of added) publishBus({ type: "jtag.changed", snapshot, change: { kind: "cable-added", label: jtagChangeLabel.added(name(c)) } })
    for (const c of removed) publishBus({ type: "jtag.changed", snapshot, change: { kind: "cable-removed", label: jtagChangeLabel.removed(name(c)) } })
    await reevaluate((s) => s.row.kind === "jtag")
  }

  async function reevaluate(filter: (s: AccessState) => boolean): Promise<void> {
    await Promise.all([...states.values()].filter(filter).map((s) => enqueue(s, () => evaluate(s))))
  }

  /** JTAG peers from the kernel table, bytes of the other kinds, and periodic target probes. */
  async function pollConnections(): Promise<void> {
    const jtag = [...states.values()].filter((s) => s.row.kind === "jtag" && s.status === "listening")
    if (jtag.length) {
      const { tcp4, tcp6 } = await procNet()
      for (const st of jtag) {
        const now = establishedTo(st.row.port, tcp4, tcp6)
        const seen = new Set(now)
        let changed = false
        for (const remote of now) {
          if (st.jtagPeers.has(remote)) continue
          st.jtagPeers.set(remote, new Date())
          changed = true
          onConnEvent(st, { kind: "connect", remote })
        }
        for (const remote of [...st.jtagPeers.keys()]) {
          if (seen.has(remote)) continue
          const since = st.jtagPeers.get(remote)
          st.jtagPeers.delete(remote)
          changed = true
          onConnEvent(st, { kind: "close", remote, ms: since ? Date.now() - since.getTime() : 0 })
        }
        if (changed) publish(st, true)
      }
    }
    const probeEvery = internals.targetProbeMs ?? 5 * 60_000
    for (const st of states.values()) {
      if (st.bridge || st.fwd) publish(st)
      if (st.fwd && Date.now() - st.lastProbe > probeEvery) void probe(st)
    }
    keepAlive()
  }

  /**
   * A remote session is activity: while any access of a reserved equipment has an established connection (xsdb or
   * Vivado on hw_server, nc/telnet on a console, ssh through the forward), the holder's reservation is renewed at the
   * normal activity cadence (the reservation service throttles touches), so a long JTAG debug session without the
   * web does not lose the reservation and get its hw_server killed.
   */
  function keepAlive(): void {
    const t = Date.now()
    for (const [k, w] of auditWindows) if (t - w.start > 2 * AUDIT_WINDOW_MS) auditWindows.delete(k)
    const busy = new Set<string>()
    for (const st of states.values()) if (connections(st).length) busy.add(st.row.equipmentId)
    for (const equipmentId of busy) touchReservation(equipmentId)
  }

  function touchReservation(equipmentId: string): void {
    const h = deps.reservations.get(equipmentId)
    if (h) deps.reservations.touch(equipmentId, h.holderId, "access")
  }

  /** hw_server processes left behind by a crash of this server (portable mode, kill -9). */
  function reapStale(): void {
    let names: string[] = []
    try { names = fs.readdirSync(pidDir) } catch { return }
    for (const n of names) {
      if (!/^hw_server-\d+\.pid$/.test(n)) continue
      const file = path.join(pidDir, n)
      const pid = Number.parseInt(fs.readFileSync(file, "utf8"), 10)
      fs.rmSync(file, { force: true })
      if (!Number.isFinite(pid) || pid <= 1) continue
      let cmd = ""
      try { cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8") } catch { continue }
      if (!/hw[_-]server/.test(cmd)) continue
      log.warn("Se detiene un hw_server que quedó de una ejecución anterior", { pid })
      try { process.kill(-pid, "SIGTERM") } catch { try { process.kill(pid, "SIGTERM") } catch { /* gone */ } }
    }
  }

  function onReservation(c: ReservationChange): void {
    for (const st of states.values()) {
      if (st.row.equipmentId !== c.equipmentId) continue
      void enqueue(st, async () => {
        st.bridge?.writableChanged()
        await evaluate(st)
        publish(st, true)
      })
    }
  }

  const settingsDTO = (): AccessSettingsDTO => ({ range: { ...cfg.accesses.range }, bind: cfg.accesses.bind, httpPort: cfg.port, maxConnections: cfg.accesses.maxConnections })

  return {
    runtime(accessId) {
      const st = states.get(accessId)
      return st ? runtimeOf(st) : null
    },
    runtimeForEquipment(equipmentId) {
      const out: Record<string, AccessRuntimeDTO> = {}
      for (const st of states.values()) if (st.row.equipmentId === equipmentId) out[st.row.id] = runtimeOf(st)
      return out
    },
    async reloadEquipment(equipmentId) {
      if (stopped) return
      const rows = await loadRows({ equipmentId })
      const ids = new Set(rows.map((r) => r.id))
      for (const st of [...states.values()]) if (st.row.equipmentId === equipmentId && !ids.has(st.row.id)) await remove(st)
      for (const r of rows) await upsert(r)
    },
    jtag: jtagSnapshot,
    async rescanJtag(actor) {
      hw = detectHwServer()
      scanning = scanning.then(() => rescan("rescan"))
      await scanning
      deps.audit.record({ actor, action: "discovery.jtag.rescan", target: { type: "discovery", name: "jtag" }, detail: { jtagCables: cables.length } })
      return jtagSnapshot()
    },
    hwServer: () => ({ ...hw }),
    labels: labelsDTO,
    cableName: (serial) => labelName("jtag", serial),
    async reloadLabels() {
      await loadLabels()
      // The adapters' shown names changed: refresh the admins' serial snapshot too.
      deps.bus.publish({ type: "serial.changed", snapshot: deps.serial.discovery.toDTO(), change: { kind: "rescan", label: jtagChangeLabel.labels } }, { kind: "admins" })
      const labels = labelsDTO()
      publishBus({ type: "cable-labels.changed", labels })
      publishBus({ type: "jtag.changed", snapshot: jtagSnapshot(), change: { kind: "labels", label: jtagChangeLabel.labels } })
      for (const st of states.values()) {
        if (st.row.kind !== "jtag" || st.status !== "cable-missing" || !st.row.cableSerial) continue
        st.detail = accessDetail.cableMissing(labelName("jtag", st.row.cableSerial) ?? st.row.cableSerial)
        publish(st)
      }
    },
    async portState(port, exceptAccessId) {
      for (const st of states.values()) {
        if (st.row.port !== port) continue
        if (st.row.id === exceptAccessId && (st.sup || st.bridge || st.fwd)) return "ours"
      }
      return (await portFree(port)) ? "free" : "busy"
    },
    settings: settingsDTO,
    stats() {
      let listening = 0
      let problems = 0
      let conns = 0
      for (const st of states.values()) {
        if (st.status === "listening") listening++
        if (["error", "port-busy", "hw-server-missing", "cable-missing", "console-missing", "network-missing"].includes(st.status)) problems++
        conns += connections(st).length
      }
      return { total: states.size, listening, problems, connections: conns, jtagCables: cables.length }
    },
    async start() {
      stopped = false
      hw = detectHwServer()
      if (hw.path) log.info("hw_server encontrado", { ruta: hw.path, version: hw.version ?? "?" })
      else log.info("hw_server no disponible: los accesos JTAG no se abrirán", { causa: hw.problem ?? "" })
      reapStale()
      await loadLabels()
      deps.serial.setAdapterLabels((identity) => labelName("serial-adapter", identity))
      try {
        cables = [...(await scanJtag())]
      } catch (err) {
        log.warn("No se pudieron enumerar los cables JTAG", { error: String(err) })
      }
      scannedAt = new Date()
      await touchSeen("jtag", cables.flatMap((c) => (c.serial ? [c.serial] : [])))
      await touchSeen("serial-adapter", deps.serial.discovery.toDTO().adapters.map((a) => adapterIdentity(a)))
      unsubscribeRes = deps.reservations.onChange((c) => {
        try { onReservation(c) } catch (err) { log.error("Error al aplicar una reserva a los accesos", { err }) }
      })
      unsubscribeBus = deps.bus.subscribe((e) => {
        if (e.type === "serial.changed" && e.change.kind === "adapter-added") {
          void touchSeen("serial-adapter", e.snapshot.adapters.map((a) => adapterIdentity(a)))
        }
        if (e.type === "console.status") {
          for (const st of states.values()) if (st.row.consoleId === e.consoleId) publish(st)
        }
      })
      for (const r of await loadRows({})) newState(r)
      await reevaluate(() => true)
      // "Red de equipos": VLAN ready/not ready, link up/down or settings changed → the switch-port forwards.
      unsubscribeNet = deps.equipnet.onRoutesChanged(() => {
        for (const st of states.values()) {
          if (st.row.kind !== "tcp" || st.row.targetMode !== "switch") continue
          void enqueue(st, async () => {
            await evaluate(st)
            publish(st, true)
          })
        }
      })
      const pollMs = internals.jtagPollMs ?? cfg.serial.scanIntervalMs
      jtagTimer = setInterval(() => { scanning = scanning.then(() => rescan("poll")) }, pollMs)
      jtagTimer.unref()
      connTimer = setInterval(() => { void pollConnections().catch((err: unknown) => log.debug("Error al leer las conexiones", { error: String(err) })) }, internals.connPollMs ?? 5000)
      connTimer.unref()
      log.info("Accesos preparados", {
        accesos: states.size, abiertos: [...states.values()].filter((s) => s.status === "listening" || s.status === "starting").length,
        cablesJtag: cables.length, puertos: `${cfg.accesses.range.from}-${cfg.accesses.range.to}`,
      })
    },
    async stop() {
      stopped = true
      if (jtagTimer) clearInterval(jtagTimer)
      if (connTimer) clearInterval(connTimer)
      jtagTimer = connTimer = null
      unsubscribeRes?.()
      unsubscribeBus?.()
      unsubscribeNet?.()
      unsubscribeNet = null
      deps.serial.setAdapterLabels(null)
      unsubscribeRes = unsubscribeBus = null
      await Promise.all([...states.values()].map(async (st) => {
        await Promise.race([st.queue, new Promise((r) => setTimeout(r, 2000).unref())])
        await stopComponents(st, accessNotice.shutdown)
      }))
    },
  }
}
