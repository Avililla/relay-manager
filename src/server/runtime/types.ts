import type { IncomingMessage, ServerResponse } from "node:http"
import type { Duplex } from "node:stream"
import type { PrismaClient } from "@/generated/prisma/client"
import type { AppConfig } from "@/server/config/schema"
import type { Logger } from "@/server/log"
import type { IsoDate, JsonValue, Page } from "@/lib/contracts/common"
import type { MatchBy } from "@/lib/contracts/enums"
import type { Audience, ServerEvent } from "@/lib/contracts/events"
import type { AuditAction, AuditEventDTO, AuditOutcome, AuditQuery, AuditTargetType } from "@/lib/contracts/audit"
import type { SettingsDTO, UpdateSettingsInput } from "@/lib/contracts/settings"
import type { ReservationCause, ReservationDTO } from "@/lib/contracts/reservations"
import type { CaptureFileDTO, ConsoleBindingRecord, ConsoleRuntimeDTO, ProbeResultDTO, SerialSnapshotDTO } from "@/lib/contracts/serial"
import type { BoardConnectionInput, BoardRuntimeDTO, DetectResultDTO, DiscoveredBoardDTO, DriverCapabilitiesDTO,
  RelayChannelStateDTO, RelayDiscoveryResultDTO, RelayScanInput } from "@/lib/contracts/relays"
import type { BackupDTO, HealthCheckDTO, SystemInfoDTO } from "@/lib/contracts/system"
import type { AccessRuntimeDTO, AccessSettingsDTO, CableLabelDTO, HwServerInfoDTO, JtagSnapshotDTO } from "@/lib/contracts/accesses"
import type { CopyRootDTO, ExportInfoDTO, FilesListingDTO, FilesRootDTO, FilesRootId, FilesSettingsDTO } from "@/lib/contracts/files"
import type {
  EquipnetEditDTO, EquipnetSettingsDTO, EquipnetSettingsInput, EquipnetStatusDTO, LinkState, ManualInstructionsDTO, NetAdapterDTO,
  SwitchDetectionDTO, SwitchJobDTO, SwitchJobKind, SwitchPreviewDTO, SwitchStatusDTO,
} from "@/lib/contracts/equipnet"

export interface AuthUser {
  id: string; username: string; name: string; isAdmin: boolean; roleIds: string[]
  mustChangePassword: boolean; sessionVersion: number
}
/** What a WS/SSE handshake gets from the session token (§5.1, §6.2). */
export interface AuthenticatedSession { user: AuthUser; sv: number; loginAt: number }
export interface ActorRef { kind: "user" | "system" | "cli"; id: string | null; name: string; ip?: string | null }
export interface UserActor extends ActorRef { kind: "user"; id: string }
export const SYSTEM_ACTOR: ActorRef = { kind: "system", id: null, name: "sistema" }

/** Login and setup-token throttle (§6.3). Lives in the runtime; W0 `src/server/auth/throttle.ts`. */
export interface LoginThrottle {
  /** Blocked → { blocked: true, retryAfterSec }. Otherwise records a pending failure now and returns a ticket. */
  begin(ip: string, username: string): { blocked: true; retryAfterSec: number } | { blocked: false; ticket: number }
  /** Turns the pending failure into a success: removes it and clears the (ip, username) window. */
  success(ip: string, username: string, ticket: number): void
  /** Setup-token attempt: false when the per-IP or the global window is exhausted. Counts the attempt. */
  setupAttempt(ip: string): boolean
  /** True at most once per (ip, username) block window: used to rate-limit the "throttled" audit. */
  shouldAuditThrottled(ip: string, username: string): boolean
}

/** One open WS or SSE session (§6.2). */
export interface LiveSession {
  userId: string; sv: number; loginAt: number
  kind: "console" | "preview" | "sse"
  /** WS: 4010 ("revoked") / 4001 ("expired"); SSE: session.revoked event, then close. */
  revoke(reason: "revoked" | "expired"): void
  /** SSE: update isAdmin and the visible set; preview: close 4004 unless admin; console: re-check visibility. */
  refresh(user: AuthUser): void
}
export interface SessionRegistry {
  register(s: LiveSession): () => void            // returns unregister
  sweep(): Promise<void>                          // every 30 s and on viewer.changed / session.revoked
  count(filter?: { userId?: string; kind?: LiveSession["kind"] }): number
  start(): void
  stop(): void
}

export interface EventBus {
  publish(event: ServerEvent, audience: Audience): void
  subscribe(listener: (event: ServerEvent, audience: Audience) => void): () => void
  listenerCount(): number
}

export interface AuditInput {
  actor: ActorRef
  action: AuditAction
  outcome?: AuditOutcome
  equipment?: { id: string; name: string } | null
  target?: { type: AuditTargetType; id?: string | null; name?: string | null } | null
  detail?: Record<string, JsonValue>
}
export interface AuditService {
  record(input: AuditInput): void
  recordNow(input: AuditInput): Promise<void>
  flush(): Promise<void>
  query(q: AuditQuery): Promise<Page<AuditEventDTO>>
  purgeOlderThan(days: number): Promise<number>
  start(): void
  stop(): void
}

export interface SettingsService {
  get(): SettingsDTO
  update(patch: UpdateSettingsInput, actor: ActorRef): Promise<SettingsDTO>
  reload(): Promise<void>
}

export interface ReservationChange {
  equipmentId: string; before: ReservationDTO | null; after: ReservationDTO | null
  cause: ReservationCause; by: ActorRef
}
export interface ReservationService {
  start(): Promise<void>
  stop(): void
  get(equipmentId: string): ReservationDTO | null
  list(): ReservationDTO[]
  isHolder(equipmentId: string, userId: string): boolean
  reserve(equipmentId: string, user: AuthUser, opts?: { note?: string | null; ip?: string | null }): Promise<ReservationDTO>
  renew(equipmentId: string, user: AuthUser, source: "button" | "console" | "relay"): Promise<ReservationDTO>
  touch(equipmentId: string, userId: string, source: "console" | "relay" | "access"): void
  release(equipmentId: string, user: AuthUser): Promise<void>
  forceRelease(equipmentId: string, admin: AuthUser, reason: string): Promise<void>
  releaseAllForUser(userId: string, cause: "user-disabled" | "user-deleted"): Promise<number>   // ReservationCause "user-removed"
  onChange(listener: (change: ReservationChange) => void): () => void
}

export interface SerialDiscoveryService {
  toDTO(): SerialSnapshotDTO                                             // annotated (assignment, inUse)
  rescan(actor: ActorRef): Promise<SerialSnapshotDTO>
  bindingFor(stableKey: string, matchBy: MatchBy | null): ConsoleBindingRecord | null   // null = device absent
  unassignedCount(): number                                              // excludes jtag-probable when hideJtag
}
/** A raw subscriber of a console (the serial-over-TCP access): same bytes as the WebSocket viewers, no presence. */
export interface ConsoleTap {
  onData(chunk: Buffer): void
  onStatus(runtime: ConsoleRuntimeDTO): void
  /** The console was deleted or reconfigured: the tap is dropped. */
  onGone(): void
}
export interface ConsoleTapHello { history: Buffer; runtime: ConsoleRuntimeDTO; key: string; label: string; equipmentName: string }

export interface ConsoleManager {
  runtime(consoleId: string): ConsoleRuntimeDTO | null
  runtimeForEquipment(equipmentId: string): Record<string, ConsoleRuntimeDTO>
  reloadConsole(consoleId: string): Promise<void>
  reloadEquipment(equipmentId: string): Promise<void>
  /** actor.id + isAdmin are checked with canWriteConsoleEquipment (§4.5 rule 8); system actor bypasses (auto-retake). */
  release(consoleId: string, actor: ActorRef & { isAdmin: boolean }, untilMin: number | null): Promise<ConsoleRuntimeDTO>
  retake(consoleId: string, actor: ActorRef & { isAdmin: boolean }): Promise<ConsoleRuntimeDTO>
  clearHistory(consoleId: string, actor: ActorRef & { isAdmin: boolean }): Promise<void>
  listCaptureFiles(consoleId: string, opts: { includeInput: boolean }): Promise<CaptureFileDTO[]>
  captureFilePath(consoleId: string, fileName: string): string | null
  /** Serial-over-TCP accesses: subscribe (gets the history tail and the runtime), unsubscribe, write. */
  attachTap(consoleId: string, tap: ConsoleTap, historyBytes: number): ConsoleTapHello | null
  detachTap(consoleId: string, tap: ConsoleTap): void
  /** Writes as-is (no Enter mapping); `who` goes to the capture input markers. The caller checks the reservation. */
  writeFromTap(consoleId: string, bytes: Buffer, who: string): "ok" | "port-not-open" | "missing"
}
export interface SerialProbeService {
  identify(stableKeys: string[], opts: { baudRate: number; listenMs: number }, actor: ActorRef): Promise<ProbeResultDTO[]>
  poke(stableKey: string, opts: { baudRate: number }, actor: ActorRef): Promise<ProbeResultDTO>
}
export type UpgradeTarget =
  | { kind: "console"; consoleId: string }
  | { kind: "preview"; stableKey: string; baudRate: number }
export interface SerialServices {
  discovery: SerialDiscoveryService
  consoles: ConsoleManager
  probe: SerialProbeService
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, target: UpgradeTarget): void
  /** The cable labels of USB-serial adapters ("Cables"), by identity; set by the access service. */
  setAdapterLabels(lookup: ((identity: string) => string | null) | null): void
  stats(): {
    openConsoles: number; problemConsoles: number; wsSessions: number; inotify: boolean
    capture: { state: "on" | "off" | "paused-disk"; totalBytes: number; lastPurgeAt: IsoDate | null }
  }
  start(): Promise<void>
  stop(): Promise<void>
}

export interface RelayController {
  reload(): Promise<void>
  boardRuntime(boardId: string): BoardRuntimeDTO | null
  capabilities(boardId: string): DriverCapabilitiesDTO | null
  channelStates(equipmentId: string): RelayChannelStateDTO[]
  set(equipmentId: string, channelId: string, on: boolean, actor: UserActor): Promise<RelayChannelStateDTO>
  pulse(equipmentId: string, channelId: string, ms: number, actor: UserActor): Promise<void>
  refresh(boardId: string): Promise<BoardRuntimeDTO>
  test(input: BoardConnectionInput, actor: ActorRef): Promise<DetectResultDTO[]>
}
export interface RelayDiscoveryService {
  known(): DiscoveredBoardDTO[]                   // passive + active + scan results, merged (§4.10)
  find(key: string): DiscoveredBoardDTO | null    // for /placas/nueva?desde=<key>
  listening(): boolean
  trafficExceeded(): boolean                      // health "Tráfico UDP 30303 excesivo"
  discoverUdp(actor: ActorRef): Promise<RelayDiscoveryResultDTO>
  scan(input: RelayScanInput, actor: ActorRef): Promise<RelayDiscoveryResultDTO>
}
export interface RelayServices {
  controller: RelayController
  discovery: RelayDiscoveryService
  simulatedAllowed(): boolean
  start(): Promise<void>
  stop(): Promise<void>
}

/** Network accesses (rt.accesses): JTAG (hw_server), serial over TCP and TCP forwards; JTAG cables; cable labels. */
export interface AccessServices {
  runtime(accessId: string): AccessRuntimeDTO | null
  runtimeForEquipment(equipmentId: string): Record<string, AccessRuntimeDTO>
  /** After an equipment (or its consoles) changed: re-reads its accesses and applies them. */
  reloadEquipment(equipmentId: string): Promise<void>
  jtag(): JtagSnapshotDTO
  rescanJtag(actor: ActorRef): Promise<JtagSnapshotDTO>
  hwServer(): HwServerInfoDTO
  /** The cable inventory, annotated (connected now, where it is used). */
  labels(): CableLabelDTO[]
  /** The label name of a JTAG cable serial (cheap; for DTOs). */
  cableName(serial: string): string | null
  /** After a label was created, renamed or deleted. */
  reloadLabels(): Promise<void>
  /** "ours": this access already listens there; "busy": another program holds it. */
  portState(port: number, exceptAccessId: string | null): Promise<"free" | "ours" | "busy">
  settings(): AccessSettingsDTO
  stats(): { total: number; listening: number; problems: number; connections: number; jtagCables: number }
  start(): Promise<void>
  stop(): Promise<void>
}

/** How a TCP forward reaches the equipment behind one switch port ("Red de equipos"). */
export interface EquipnetRoute {
  /** The network is set up (enabled, adapter chosen) and the port is an equipment port. */
  configured: boolean
  vid: number | null
  /** The server's address in that port's VLAN (the forward binds to it; policy routing does the rest). */
  localAddress: string | null
  /** VLAN interface, address, rule and route are in place. */
  ready: boolean
  link: LinkState
  equipmentIp: string | null
  /** Why it is not usable (Spanish), or null. */
  problem: string | null
}
/** "Red de equipos" (rt.equipnet): USB network adapters, the server's VLAN interfaces and the equipment switch. */
export interface EquipnetServices {
  status(): EquipnetStatusDTO
  settings(): EquipnetSettingsDTO
  adapters(): NetAdapterDTO[]
  /** What the access editors need; `equipmentId` = the equipment being edited (its own ports count as free). */
  editContext(equipmentId: string | null): EquipnetEditDTO
  route(switchPort: number): EquipnetRoute
  /** Readiness, links or settings changed (the access service re-evaluates its switch-port forwards). */
  onRoutesChanged(listener: () => void): () => void
  /** Saves the settings; `warnings`: situations that work but the admin should know (another NIC on the same network…). */
  saveSettings(input: EquipnetSettingsInput, actor: ActorRef): Promise<{ settings: EquipnetSettingsDTO; warnings: string[] }>
  /** «Buscar el switch» on the chosen interface only: a sweep of its management network, or only `host` when typed. */
  discover(host: string | null, actor: ActorRef): Promise<SwitchDetectionDTO | null>
  /** Step 1: the interface wired to the switch (null = stop using it). Interfaces with a warning need `confirmed`. */
  chooseAdapter(input: { mac: string | null; confirmed: boolean }, actor: ActorRef): Promise<EquipnetStatusDTO>
  /** Removes what older versions left on interfaces the app may not touch on its own (explicit request). */
  cleanupLeftovers(actor: ActorRef): Promise<EquipnetStatusDTO>
  testSwitch(actor: ActorRef): Promise<SwitchStatusDTO>
  preview(kind: SwitchJobKind, actor: ActorRef): Promise<SwitchPreviewDTO>
  apply(input: { kind: SwitchJobKind; planId: string; uplinkConfirmed: boolean }, actor: ActorRef): Promise<SwitchJobDTO>
  /** Step 3, «Preparar switch»: password → settings saved and the switch prepared (or the preview when it cannot). */
  prepare(input: { password?: string; username?: string; uplinkConfirmed: boolean }, actor: ActorRef): Promise<{ started: boolean; preview: SwitchPreviewDTO | null; job: SwitchJobDTO | null; warnings: string[] }>
  previewPrepare(input: { password?: string; username?: string }, actor: ActorRef): Promise<SwitchPreviewDTO>
  reconcileNow(actor: ActorRef): Promise<EquipnetStatusDTO>
  manualInstructions(): ManualInstructionsDTO
  /** The switch configuration backup taken before the last change (admins download it). */
  backupFile(): string | null
  /** After an equipment was saved or deleted: which accesses use which switch ports. */
  reloadUsage(): Promise<void>
  /** After a net-adapter label changed. */
  reloadLabels(): Promise<void>
  health(): HealthCheckDTO[]
  start(): Promise<void>
  stop(): Promise<void>
}

/** The state of the files folder (health, Archivos page). */
export interface FilesStatus {
  enabled: boolean
  root: string
  /** null = usable; otherwise why not, in Spanish. */
  problem: string | null
  writable: boolean
  freeBytes: number | null
  totalBytes: number | null
}
/**
 * "Archivos" (rt.files): file exchange with the shared folders («raíces»: "tftp" = RM_FILES_DIR, "extra" = RM_FILES_EXTRA_DIR, named by the profile).
 * Paths are relative to the root ("" = the root folder). A disabled root answers NOT_FOUND.
 */
export interface FilesService {
  settings(): FilesSettingsDTO
  /** The enabled roots, with their absolute paths (the page shows them to administrators only). */
  roots(): FilesRootDTO[]
  /** The "tftp" root (health, as before). */
  status(): Promise<FilesStatus>
  statusOf(root: FilesRootId): Promise<FilesStatus>
  list(root: FilesRootId, relPath: string): Promise<FilesListingDTO>
  mkdir(root: FilesRootId, dir: string, name: string, actor: ActorRef): Promise<{ path: string }>
  rename(root: FilesRootId, relPath: string, newName: string, actor: ActorRef): Promise<{ path: string }>
  move(root: FilesRootId, relPaths: string[], toDir: string, actor: ActorRef): Promise<{ moved: number }>
  remove(root: FilesRootId, relPaths: string[], actor: ActorRef): Promise<{ removed: number }>
  /** «Descargas» (the profile's download script). */
  exportInfo(): Promise<ExportInfoDTO>
  /** Graph A HTTP API under /api/files/ (list, download, zip, chunked upload). false = not a files path. */
  handleRequest(req: IncomingMessage, res: ServerResponse): boolean
  stats(): {
    uploads: number; sends: { active: number; queued: number }; copies: { active: number; queued: number }
    exports: { running: number; queued: number }
  }
  /** «Copiar como administrador (sudo)»: is the root helper there and usable (Sistema › Salud). */
  copyRootStatus(): Promise<CopyRootDTO>
  start(): Promise<void>
  stop(): Promise<void>
}

export interface BackupService {
  create(label: string, actor: ActorRef): Promise<BackupDTO>
  list(): Promise<BackupDTO[]>
  remove(name: string, actor: ActorRef): Promise<void>
  resolvePath(name: string): string | null
  prune(): Promise<number>
}
export interface HealthService {
  run(opts?: { runtimeChecks?: boolean; only?: readonly string[] }): Promise<HealthCheckDTO[]>
}
export interface OpsServices {
  backups: BackupService
  health: HealthService
  info(): Promise<SystemInfoDTO>
  start(): Promise<void>
  stop(): Promise<void>
}

export interface RuntimeState { setupPending: boolean; startedAt: Date; uncaughtErrors: number }

export interface Runtime {
  config: AppConfig
  log: Logger
  prisma: PrismaClient
  bus: EventBus
  audit: AuditService
  settings: SettingsService
  throttle: LoginThrottle
  sessions: SessionRegistry
  reservations: ReservationService
  serial: SerialServices
  relays: RelayServices
  accesses: AccessServices
  equipnet: EquipnetServices
  files: FilesService
  ops: OpsServices
  state: RuntimeState
}

/** Factory dependency bundles (factories live in the owning workstream's index.ts). */
export interface ServiceDeps { config: AppConfig; log: Logger; prisma: PrismaClient; bus: EventBus; audit: AuditService; settings: SettingsService }
export interface ReservationDeps extends ServiceDeps { now?: () => Date }
export interface SerialDeps extends ServiceDeps {
  reservations: ReservationService
  sessions: SessionRegistry
  authenticate(req: IncomingMessage): Promise<AuthenticatedSession | null>   // W0 authenticateUpgrade (§5.1)
}
export interface RelayDeps extends ServiceDeps { reservations: ReservationService }
export interface OpsDeps extends ServiceDeps { getRuntime(): Runtime | undefined }
export interface FilesDeps extends ServiceDeps {
  authenticate(req: IncomingMessage): Promise<AuthenticatedSession | null>   // W0 authenticateUpgrade (cookie only)
  /** «Enviar a equipo» (without them the send API answers 404). */
  reservations?: ReservationService
  equipnet?: EquipnetServices
}
/** Stateless domain modules (src/server/services/*.ts) receive this subset. */
export type DomainDeps = Pick<Runtime, "prisma" | "bus" | "audit" | "settings" | "reservations" | "serial" | "relays" | "accesses" | "equipnet" | "log">
