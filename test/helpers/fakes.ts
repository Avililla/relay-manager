import type { Audience, ServerEvent } from "@/lib/contracts/events"
import type { SettingsDTO, UpdateSettingsInput } from "@/lib/contracts/settings"
import type { ReservationDTO } from "@/lib/contracts/reservations"
import type {
  ActorRef, AuditInput, AuditService, AuthUser, EquipnetServices, EventBus, LiveSession, ReservationService, Runtime, SessionRegistry,
  SettingsService,
} from "@/server/runtime/types"
import type { EquipnetSettingsDTO, EquipnetStatusDTO } from "@/lib/contracts/equipnet"
import type { AppConfig } from "@/server/config/schema"
import { createLoginThrottle } from "@/server/auth/throttle"
import { createNullLogger } from "@/server/log"
import { DomainError } from "@/server/errors"
import pkg from "../../package.json"

export function fakeBus(): EventBus & { events: Array<{ event: ServerEvent; audience: Audience }> } {
  const listeners = new Set<(e: ServerEvent, a: Audience) => void>()
  const events: Array<{ event: ServerEvent; audience: Audience }> = []
  return {
    events,
    publish(event, audience) { events.push({ event, audience }); for (const l of [...listeners]) l(event, audience) },
    subscribe(l) { listeners.add(l); return () => { listeners.delete(l) } },
    listenerCount: () => listeners.size,
  }
}

export function fakeAudit(): AuditService & { inputs: AuditInput[] } {
  const inputs: AuditInput[] = []
  return {
    inputs,
    record(i) { inputs.push(i) },
    async recordNow(i) { inputs.push(i) },
    async flush() {},
    async query() { return { items: [], nextCursor: null } },
    async purgeOlderThan() { return 0 },
    start() {},
    stop() {},
  }
}

export const DEFAULT_SETTINGS: SettingsDTO = {
  labName: "Relay Manager", bannerText: null,
  reservationTimeoutMin: 30, reservationWarningMin: 5,
  captureRetentionDays: 30, captureMaxTotalMb: 2048, captureMaxFileMb: 64, inputCapture: "markers",
  auditRetentionDays: 365,
  backupDailyEnabled: true, backupDailyHour: 3, backupRetentionCount: 14,
  setupCompletedAt: null, updatedAt: "2026-09-23T10:00:00.000Z",
}

export function fakeSettings(partial: Partial<SettingsDTO> = {}): SettingsService & { current: SettingsDTO } {
  const s = { current: { ...DEFAULT_SETTINGS, ...partial } }
  return {
    get current() { return s.current },
    get: () => s.current,
    async update(patch: UpdateSettingsInput, actor: ActorRef) { void actor; s.current = { ...s.current, ...patch }; return s.current },
    async reload() {},
  }
}

/** In-memory ReservationService: `holders` maps equipmentId → userId. */
export function fakeReservations(opts: { holders?: Record<string, string> } = {}): ReservationService & { holders: Map<string, string> } {
  const holders = new Map(Object.entries(opts.holders ?? {}))
  const dto = (equipmentId: string, userId: string): ReservationDTO => ({
    equipmentId, holderId: userId, holderName: userId, holderUsername: userId,
    reservedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(), note: null,
  })
  return {
    holders,
    async start() {},
    stop() {},
    get: (id) => { const u = holders.get(id); return u ? dto(id, u) : null },
    list: () => [...holders].map(([id, u]) => dto(id, u)),
    isHolder: (id, userId) => holders.get(id) === userId,
    async reserve(id, user: AuthUser) {
      const h = holders.get(id)
      if (h && h !== user.id) throw new DomainError("RESERVED_BY_OTHER", "Reservado por otro usuario")
      holders.set(id, user.id); return dto(id, user.id)
    },
    async renew(id, user) {
      if (holders.get(id) !== user.id) throw new DomainError("NOT_HOLDER", "No tienes la reserva")
      return dto(id, user.id)
    },
    touch() {},
    async release(id, user) {
      if (holders.get(id) !== user.id) throw new DomainError("NOT_HOLDER", "No tienes la reserva")
      holders.delete(id)
    },
    async forceRelease(id) { holders.delete(id) },
    async releaseAllForUser(userId) {
      let n = 0
      for (const [id, u] of holders) if (u === userId) { holders.delete(id); n++ }
      return n
    },
    onChange: () => () => {},
  }
}

/** SessionRegistry that records registrations; tests trigger revoke/refresh on them directly. */
export function fakeSessions(): SessionRegistry & { sessions: Set<LiveSession> } {
  const sessions = new Set<LiveSession>()
  return {
    sessions,
    register(s) { sessions.add(s); return () => { sessions.delete(s) } },
    async sweep() {},
    count(f) {
      return [...sessions].filter((s) => (!f?.userId || s.userId === f.userId) && (!f?.kind || s.kind === f.kind)).length
    },
    start() {},
    stop() {},
  }
}

export function testConfig(partial: Partial<AppConfig> = {}): AppConfig {
  return {
    mode: "dev", dev: true,
    appDir: "/tmp/rm-app", bundleRoot: null, configFile: null,
    dataDir: "/tmp/rm-data", dbFile: "/tmp/rm-data/relay-manager.db", backupDir: "/tmp/rm-data/backups", captureDir: "/tmp/rm-data/consoles",
    pidFile: "/tmp/rm-data/server.pid", lockFile: "/tmp/rm-data/.instance-lock",
    host: "127.0.0.1", port: 3000, tls: null, sessionMaxAgeHours: 12, logLevel: "error",
    authSecret: "test-secret-test-secret-test-secret-0123456789", setupTokenOverride: null,
    allowUnknownMigrations: false, allowRoot: false,
    serial: { devRoot: "/dev", sysRoot: "/sys", extraGlobs: [], includeBuiltin: false, hideJtag: true, scanIntervalMs: 2000, settleMs: 800, allowPoke: true, historyBytes: 256 * 1024 },
    capture: { enabled: true },
    files: {
      enabled: true, dir: "/tmp/rm-files", maxUploadBytes: 4096 * 1024 * 1024, deleteAdminOnly: false,
      extraEnabled: true, extraDir: "/tmp/rm-compartida", extraName: "Compartida", extraHint: "Segunda carpeta compartida",
    },
    exports: {
      enabled: true, script: "/tmp/rm-perfil/herramientas/descarga.sh", timeoutMs: 3600_000, root: "extra",
      name: "Descargas", title: "Ejecutar script de descarga…", description: "Descripción", appLabel: "Aplicación", versionLabel: "Versión", extractLabel: "Opción -x",
      user: null, password: null, url: "http://127.0.0.1:9/repositorio",
      envUser: "EXPORT_USER", envPassword: "EXPORT_PASSWORD", envUrl: "EXPORT_URL", envExtra: {},
    },
    copy: { enabled: true, roots: ["/"], deny: [], rootPaths: ["/media", "/run/media", "/mnt"], sudoUser: "tester", helperSocket: null, testRemovable: null },
    accesses: { range: { from: 3201, to: 3230 }, bind: "127.0.0.1", hwServer: null, jtagSysRoot: "/sys", maxConnections: 8, hwServerFilter: "{serial}" },
    net: { hostMode: "off", sysRoot: "/nonexistent-sys", ipBin: null, allowNonUsb: false, switchHttpPort: 80, pollMs: 10000 },
    relays: { pollMs: 5000, offlinePollMs: 15000, timeoutMs: 1500, passiveDiscovery: false, discoveryPort: 30303, broadcastTargets: null, scanCidrs: null, scanPorts: [80], simulate: true },
    profile: { dir: null, path: "/tmp/rm-app/perfil", explicit: false, envFile: null, warnings: [] },
    defaults: { labName: "Relay Manager", equipmentIp: "192.168.1.10", equipmentPort: 22 },
    build: { version: pkg.version, buildId: "dev", rev: "dev", builtAt: null },
    ...partial,
  }
}

function unavailable(): never { throw new DomainError("SERVICE_UNAVAILABLE", "Función aún no implementada") }

/** "Red de equipos" not set up (no adapter): every switch port route says why. Override pieces in tests. */
export function fakeEquipnet(partial: Partial<EquipnetServices> = {}): EquipnetServices {
  const settings: EquipnetSettingsDTO = {
    enabled: false, adapterMac: null, driver: "tplink-easy-smart", switchHost: null, switchUsername: null, hasPassword: false,
    portCount: 8, uplinkPort: 1, vlanBase: 100, mgmtAddress: "192.168.0.250/24", equipmentIp: "192.168.1.10", equipmentPrefix: 24, hostOffset: 200,
  }
  const status: EquipnetStatusDTO = {
    settings, adapters: [], host: { state: "off", detail: null, pending: [], canApply: false, ifname: null, networkManagerHint: null, checkedAt: null },
    switch: { state: "unconfigured", detail: null, info: { model: null, hardware: null, firmware: null, mac: null, portCount: null }, dot1qEnabled: null, matches: null, drift: [], checkedAt: null },
    otherInterfaces: [], mgmt: { mode: "none", address: null, subnet: null, ifname: null, ready: false, problem: null }, warnings: [], leftovers: { items: [], commands: [] },
    ports: [], detection: null, offerSetup: false, job: null, appliedAt: null, previousAt: null, hasBackup: false, hostMode: "off",
  }
  return {
    status: () => status, settings: () => settings, adapters: () => [],
    editContext: () => ({ configured: false, equipmentIp: "192.168.1.10", equipmentPort: 22, portCount: 8, uplinkPort: 1, ports: [], suggestedPort: null }),
    route: () => ({ configured: false, vid: null, localAddress: null, ready: false, link: "unknown", equipmentIp: "192.168.1.10", problem: "La red de equipos no está activada (Sistema › Red de equipos)." }),
    onRoutesChanged: () => () => {},
    saveSettings: async () => unavailable(), discover: async () => unavailable(), testSwitch: async () => unavailable(),
    chooseAdapter: async () => unavailable(), cleanupLeftovers: async () => unavailable(),
    preview: async () => unavailable(), apply: async () => unavailable(), prepare: async () => unavailable(), previewPrepare: async () => unavailable(),
    reconcileNow: async () => status, manualInstructions: () => ({ rows: [], vlans: [], notes: [] }), backupFile: () => null,
    reloadUsage: async () => {}, reloadLabels: async () => {}, health: () => [],
    start: async () => {}, stop: async () => {},
    ...partial,
  }
}

/** A Runtime-shaped object for query and action tests (with a real createLoginThrottle()). */
export function fakeRuntime(partial: Partial<Runtime> = {}): Runtime {
  const bus = partial.bus ?? fakeBus()
  const now = new Date().toISOString()
  const rt: Runtime = {
    config: testConfig(),
    log: createNullLogger(),
    prisma: undefined as unknown as Runtime["prisma"],
    bus,
    audit: fakeAudit(),
    settings: fakeSettings(),
    throttle: createLoginThrottle(),
    sessions: fakeSessions(),
    reservations: fakeReservations(),
    serial: {
      discovery: {
        toDTO: () => ({ scannedAt: now, adapters: [], others: [], hiddenJtag: 0, watcher: { inotify: false, intervalMs: 2000 } }),
        rescan: async () => unavailable(),
        bindingFor: () => null,
        unassignedCount: () => 0,
      },
      consoles: {
        runtime: () => null, runtimeForEquipment: () => ({}), reloadConsole: async () => {}, reloadEquipment: async () => {},
        release: async () => unavailable(), retake: async () => unavailable(), clearHistory: async () => unavailable(),
        listCaptureFiles: async () => [], captureFilePath: () => null,
        attachTap: () => null, detachTap: () => {}, writeFromTap: () => "missing",
      },
      probe: { identify: async () => unavailable(), poke: async () => unavailable() },
      handleUpgrade: (_req, socket) => { socket.destroy() },
      setAdapterLabels: () => {},
      stats: () => ({ openConsoles: 0, problemConsoles: 0, wsSessions: 0, inotify: false, capture: { state: "off", totalBytes: 0, lastPurgeAt: null } }),
      start: async () => {}, stop: async () => {},
    },
    relays: {
      controller: {
        reload: async () => {}, boardRuntime: () => null, capabilities: () => null, channelStates: () => [],
        set: async () => unavailable(), pulse: async () => unavailable(), refresh: async () => unavailable(), test: async () => unavailable(),
      },
      discovery: {
        known: () => [], find: () => null, listening: () => false, trafficExceeded: () => false,
        discoverUdp: async () => unavailable(), scan: async () => unavailable(),
      },
      simulatedAllowed: () => false,
      start: async () => {}, stop: async () => {},
    },
    accesses: {
      runtime: () => null, runtimeForEquipment: () => ({}), reloadEquipment: async () => {},
      jtag: () => ({ scannedAt: now, cables: [] }), rescanJtag: async () => unavailable(),
      hwServer: () => ({ path: null, version: null, source: null, problem: null }),
      labels: () => [], cableName: () => null, reloadLabels: async () => {},
      portState: async () => "free",
      settings: () => ({ range: { from: 3201, to: 3230 }, bind: "0.0.0.0", httpPort: 3200, maxConnections: 8 }),
      stats: () => ({ total: 0, listening: 0, problems: 0, connections: 0, jtagCables: 0 }),
      start: async () => {}, stop: async () => {},
    },
    equipnet: fakeEquipnet(),
    files: {
      settings: () => ({ maxUploadBytes: 4096 * 1024 * 1024, chunkMaxBytes: 64 * 1024 * 1024, deleteAdminOnly: false }),
      roots: () => [
        { id: "tftp", label: "tftp", hint: "Imágenes y archivos para los equipos (~/tftp)", enabled: true, path: "/tmp/rm-files" },
        { id: "extra", label: "Compartida", hint: "Segunda carpeta compartida", enabled: true, path: "/tmp/rm-compartida" },
      ],
      status: async () => ({ enabled: true, root: "/tmp/rm-files", problem: null, writable: true, freeBytes: null, totalBytes: null }),
      statusOf: async (root) => ({ enabled: true, root: root === "extra" ? "/tmp/rm-compartida" : "/tmp/rm-files", problem: null, writable: true, freeBytes: null, totalBytes: null }),
      exportInfo: async () => ({
        available: false, problem: "sin script", timeoutMin: 60, root: "extra", rootLabel: "Compartida",
        labels: { name: "Descargas", title: "Ejecutar script de descarga…", description: "Descripción", app: "Aplicación", version: "Versión", extract: null },
      }),
      list: async () => unavailable(),
      mkdir: async () => unavailable(), rename: async () => unavailable(), move: async () => unavailable(), remove: async () => unavailable(),
      handleRequest: () => false,
      stats: () => ({ uploads: 0, sends: { active: 0, queued: 0 }, copies: { active: 0, queued: 0 }, exports: { running: 0, queued: 0 } }),
      copyRootStatus: async () => ({ available: false, user: null, problem: "sin ayudante", hint: null, writePaths: [] }),
      start: async () => {}, stop: async () => {},
    },
    ops: {
      backups: { create: async () => unavailable(), list: async () => [], remove: async () => unavailable(), resolvePath: () => null, prune: async () => 0 },
      health: { run: async () => [] },
      info: async () => unavailable(),
      start: async () => {}, stop: async () => {},
    },
    state: { setupPending: false, startedAt: new Date(), uncaughtErrors: 0 },
    ...partial,
  }
  return rt
}
