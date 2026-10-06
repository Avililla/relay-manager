// Row → DTO mapping shared by the W1-C services and queries. Pure, stateless (§2.2 rule 3).
import type { EquipmentAccess, EquipmentTemplate, Prisma, RelayBoard, RelayChannel, SerialConsole } from "@/generated/prisma/client"
import { AccessKindSchema, AccessPolicySchema, type AccessDTO, type AccessRuntimeDTO } from "@/lib/contracts/accesses"
import type { ConsoleDetailDTO, ConsoleSummaryDTO, RelayChannelSummaryDTO } from "@/lib/contracts/equipment"
import type { RelayChannelStateDTO } from "@/lib/contracts/relays"
import {
  DataBitsSchema, DEFAULT_LINE, EnterModeSchema, FlowControlSchema, MatchBySchema, ParitySchema, RelayPurposeSchema,
  StopBitsSchema, type EnterMode, type LineSettings, type MatchBy, type RelayPurpose,
} from "@/lib/contracts/enums"
import { ConsoleBindingRecordSchema, type ConsoleBindingRecord, type ConsoleRuntimeDTO } from "@/lib/contracts/serial"
import { TemplateSpecSchema, type TemplateDTO, type TemplateSpec } from "@/lib/contracts/templates"
import { adapterShort } from "@/lib/serial/format"
import type { RelayServices } from "@/server/runtime/types"

type BindingColumns = Pick<SerialConsole,
  "matchBy" | "bindingKey" | "byId" | "byPath" | "usbVendorId" | "usbProductId" | "usbSerial" | "usbInterface" | "usbPortNumber"
  | "usbIdPath" | "devicePath" | "adapterLabel" | "lastDevNode">

/** Prisma data that clears every binding column (unbound console). */
export const UNBOUND: { [K in keyof BindingColumns]: null } & { lastSeenAt: null } = {
  matchBy: null, bindingKey: null, byId: null, byPath: null, usbVendorId: null, usbProductId: null, usbSerial: null,
  usbInterface: null, usbPortNumber: null, usbIdPath: null, devicePath: null, adapterLabel: null, lastDevNode: null, lastSeenAt: null,
}

/** Prisma data for a binding record produced by W1-A `bindingFor` (W1-C never builds binding records itself, §4.4). */
export function bindingData(b: ConsoleBindingRecord, seenAt: Date): BindingColumns & { lastSeenAt: Date } {
  return {
    matchBy: b.matchBy, bindingKey: b.bindingKey, byId: b.byId, byPath: b.byPath, usbVendorId: b.usbVendorId,
    usbProductId: b.usbProductId, usbSerial: b.usbSerial, usbInterface: b.usbInterface, usbPortNumber: b.usbPortNumber,
    usbIdPath: b.usbIdPath, devicePath: b.devicePath, adapterLabel: b.adapterLabel, lastDevNode: b.lastDevNode, lastSeenAt: seenAt,
  }
}

/** The persisted binding as a record, or null when unbound. `validate` drops records that fail the contract refinements. */
export function bindingRecordFromRow(r: BindingColumns, opts: { validate?: boolean } = {}): ConsoleBindingRecord | null {
  const matchBy = MatchBySchema.safeParse(r.matchBy)
  if (!matchBy.success || !r.bindingKey) return null
  const rec: ConsoleBindingRecord = {
    matchBy: matchBy.data, bindingKey: r.bindingKey, byId: r.byId, byPath: r.byPath, usbVendorId: r.usbVendorId,
    usbProductId: r.usbProductId, usbSerial: r.usbSerial, usbInterface: r.usbInterface, usbPortNumber: r.usbPortNumber,
    usbIdPath: r.usbIdPath, devicePath: r.devicePath, adapterLabel: r.adapterLabel, lastDevNode: r.lastDevNode,
  }
  if (!opts.validate) return rec
  const ok = ConsoleBindingRecordSchema.safeParse(rec)
  return ok.success ? ok.data : null
}

export function lineFromRow(r: Pick<SerialConsole, "baudRate" | "dataBits" | "parity" | "stopBits" | "flowControl">): LineSettings {
  const dataBits = DataBitsSchema.safeParse(r.dataBits)
  const parity = ParitySchema.safeParse(r.parity)
  const stopBits = StopBitsSchema.safeParse(r.stopBits)
  const flow = FlowControlSchema.safeParse(r.flowControl)
  return {
    baudRate: r.baudRate,
    dataBits: dataBits.success ? dataBits.data : DEFAULT_LINE.dataBits,
    parity: parity.success ? parity.data : DEFAULT_LINE.parity,
    stopBits: stopBits.success ? stopBits.data : DEFAULT_LINE.stopBits,
    flowControl: flow.success ? flow.data : DEFAULT_LINE.flowControl,
  }
}

export function enterModeOf(v: string): EnterMode {
  const p = EnterModeSchema.safeParse(v)
  return p.success ? p.data : "cr"
}
export function purposeOf(v: string): RelayPurpose {
  const p = RelayPurposeSchema.safeParse(v)
  return p.success ? p.data : "generic"
}
export function matchByOf(v: string | null): MatchBy | null {
  const p = MatchBySchema.safeParse(v)
  return p.success ? p.data : null
}

/** Runtime shown while the console manager has no state for a console (e.g. just created, or services not started). */
export function defaultConsoleRuntime(r: Pick<SerialConsole, "bindingKey" | "matchBy" | "releasedAt" | "releasedByName" | "releaseUntil" | "lastDevNode" | "updatedAt" | "captureToDisk">): ConsoleRuntimeDTO {
  const bound = !!r.bindingKey && !!r.matchBy
  const released = bound && r.releasedAt && (!r.releaseUntil || r.releaseUntil.getTime() > Date.now())
  return {
    status: !bound ? "unbound" : released ? "released" : "opening",
    devNode: bound ? r.lastDevNode : null,
    detail: null,
    since: r.updatedAt.toISOString(),
    lastRxAt: null,
    lastLine: null,
    viewers: 0,
    released: released && r.releasedAt
      ? { byName: r.releasedByName ?? "", at: r.releasedAt.toISOString(), until: r.releaseUntil ? r.releaseUntil.toISOString() : null }
      : null,
    capture: r.captureToDisk ? "off" : "disabled",
  }
}

export function toConsoleSummary(r: SerialConsole, runtime: ConsoleRuntimeDTO | null | undefined): ConsoleSummaryDTO {
  return {
    id: r.id, key: r.key, label: r.label, position: r.position,
    line: lineFromRow(r), enterMode: enterModeOf(r.enterMode), localEcho: r.localEcho,
    matchBy: matchByOf(r.matchBy), adapterLabel: r.bindingKey ? r.adapterLabel : null,
    adapterShort: adapterShort(bindingRecordFromRow(r)),
    runtime: runtime ?? defaultConsoleRuntime(r),
  }
}

export function toConsoleDetail(r: SerialConsole, runtime: ConsoleRuntimeDTO | null | undefined): ConsoleDetailDTO {
  const rec = bindingRecordFromRow(r)
  return {
    ...toConsoleSummary(r, runtime),
    hupcl: r.hupcl, captureToDisk: r.captureToDisk,
    identify: { hostnameRegex: r.identifyHostnameRegex, bannerRegex: r.identifyBannerRegex },
    binding: rec ? { ...rec, lastSeenAt: r.lastSeenAt ? r.lastSeenAt.toISOString() : null } : null,
  }
}

/** `states` = controller.channelStates(equipmentId), computed once per equipment by the caller when available. */
export function toRelaySummary(
  r: RelayChannel & { board: Pick<RelayBoard, "id" | "name"> },
  relays: Pick<RelayServices, "controller">,
  states: readonly RelayChannelStateDTO[] = relays.controller.channelStates(r.equipmentId),
): RelayChannelSummaryDTO {
  const state = states.find((s) => s.channelId === r.id)
  const caps = relays.controller.capabilities(r.boardId)
  return {
    id: r.id, key: r.key, label: r.label, purpose: purposeOf(r.purpose), position: r.position,
    requireConfirm: r.requireConfirm, defaultPulseMs: r.defaultPulseMs,
    boardId: r.boardId, boardName: r.board.name, channel: r.channel,
    on: state?.on ?? null, stale: state?.stale ?? false,
    boardOnline: relays.controller.boardRuntime(r.boardId)?.online ?? null,
    pulse: caps?.pulse ?? "none", pulseMs: caps?.pulseMs ?? null,
  }
}

const EMPTY_SPEC: TemplateSpec = { version: 1, namePattern: "{template} #{nn}", skipInterfaces: [], consoles: [], relays: [], accesses: [] }

/** Template spec JSON from the DB, validated (§0.1). An invalid stored spec yields an empty spec (never throws). */
export function parseTemplateSpec(json: Prisma.JsonValue | unknown): TemplateSpec {
  const p = TemplateSpecSchema.safeParse(json)
  return p.success ? p.data : { ...EMPTY_SPEC }
}

export function toTemplateDTO(r: EquipmentTemplate, equipmentCount: number): TemplateDTO {
  return {
    id: r.id, key: r.key, name: r.name, description: r.description,
    source: r.source === "file" ? "file" : "local", sourceFile: r.sourceFile, retired: r.retiredAt !== null, needsReview: r.needsReview,
    spec: parseTemplateSpec(r.spec), position: r.position, equipmentCount, updatedAt: r.updatedAt.toISOString(),
  }
}

/** Case-insensitive, accent-sensitive name comparison used for every "name already exists" check. */
export function sameName(a: string, b: string): boolean {
  return a.trim().toLocaleLowerCase("es") === b.trim().toLocaleLowerCase("es")
}

/** Numeric-aware Spanish collation for names ("#2" before "#10"). */
export const byName = (a: { name: string }, b: { name: string }): number => a.name.localeCompare(b.name, "es", { numeric: true })

// ---------------------------------------------------------------------------------------------------------------------
// Accesses

type AccessRow = Pick<EquipmentAccess, "id" | "equipmentId" | "position" | "key" | "label" | "kind" | "port" | "enabled" | "policy"
  | "jtagCableSerial" | "consoleId" | "targetHost" | "targetPort" | "targetMode" | "switchPort" | "sshUser"> & { console?: { key: string } | null }

/** When the service has no state for it (not loaded yet): closed, with the reason the policy gives. */
export const IDLE_ACCESS_RUNTIME: AccessRuntimeDTO = {
  status: "stopped", reason: null, detail: null, since: new Date(0).toISOString(), connections: [], writable: false, targetReachable: null, pid: null,
  network: null,
}

export function toAccessDTO(a: AccessRow, runtime: AccessRuntimeDTO | null | undefined, labelOf: (serial: string) => string | null): AccessDTO {
  const kind = AccessKindSchema.safeParse(a.kind)
  const policy = AccessPolicySchema.safeParse(a.policy)
  return {
    id: a.id, equipmentId: a.equipmentId, position: a.position, key: a.key, label: a.label,
    kind: kind.success ? kind.data : "tcp", port: a.port, enabled: a.enabled, policy: policy.success ? policy.data : "reserved",
    cableSerial: a.jtagCableSerial, cableName: a.jtagCableSerial ? labelOf(a.jtagCableSerial) : null,
    consoleId: a.consoleId, consoleKey: a.console?.key ?? null, targetHost: a.targetHost, targetPort: a.targetPort,
    targetMode: a.targetMode === "switch" ? "switch" : "ip", switchPort: a.switchPort, sshUser: a.sshUser,
    runtime: runtime ?? IDLE_ACCESS_RUNTIME,
  }
}
