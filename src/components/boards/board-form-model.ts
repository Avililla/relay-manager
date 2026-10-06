// Placas de relés form (§8.9): the draft the form edits, its conversion to the action input, and the rule that a
// non-simulated board must pass "Probar conexión" before its first save. Pure.
import type { z } from "zod"
import type { DriverId } from "@/lib/contracts/enums"
import { BoardInputSchema, type BoardDTO, type BoardInput, type BoardOptions, type DetectResultDTO, type DiscoveredBoardDTO } from "@/lib/contracts/relays"
import { DEFAULT_TCP_PORT, driverCapabilities } from "@/lib/relays/capabilities"
import { modelByName, modelRelayCount, RELAY_MODELS, type RelayModelInfo } from "@/lib/relays/models"

export interface BoardDraft {
  name: string
  driver: DriverId
  host: string
  httpPort: string
  tcpPort: string
  model: string | null
  moduleId: number | null
  relayCount: number
  mac: string
  toggleVar: string
  useHttpFallback: boolean
  transport: "tcp" | "http"
  username: string
  /** New password text; empty keeps the saved one (edit) or means none (create). */
  password: string
  clearPassword: boolean
  enabled: boolean
  /** Simulator options are not edited in the form: they are carried over unchanged. */
  sim: BoardOptions["sim"] | undefined
}

export type FieldErrors = Record<string, string[]>

export function emptyDraft(): BoardDraft {
  return {
    name: "", driver: "devantech-ds-ascii", host: "", httpPort: "80", tcpPort: "", model: null, moduleId: null, relayCount: 8,
    mac: "", toggleVar: "", useHttpFallback: false, transport: "tcp", username: "", password: "", clearPassword: false, enabled: true,
    sim: undefined,
  }
}

export function draftFromBoard(b: BoardDTO): BoardDraft {
  return {
    name: b.name, driver: b.driver, host: b.host, httpPort: String(b.httpPort), tcpPort: b.tcpPort === null ? "" : String(b.tcpPort),
    model: b.model, moduleId: b.moduleId, relayCount: b.relayCount, mac: b.mac ?? "", toggleVar: b.options.toggleVar ?? "",
    useHttpFallback: !!b.options.useHttpFallback, transport: b.options.transport ?? "tcp", username: b.username ?? "", password: "",
    clearPassword: false, enabled: b.enabled, sim: b.options.sim,
  }
}

/** Copies what a detect result knows into the draft ("Usar estos valores"). The name and credentials are kept. */
export function applyDetect(d: BoardDraft, det: DetectResultDTO): BoardDraft {
  const model = det.model ?? d.model
  return {
    ...d,
    driver: det.driver,
    host: det.host || d.host,
    httpPort: det.httpPort ? String(det.httpPort) : d.httpPort,
    tcpPort: det.tcpPort ? String(det.tcpPort) : DEFAULT_TCP_PORT[det.driver] === null ? "" : d.tcpPort,
    model,
    moduleId: det.moduleId ?? d.moduleId,
    relayCount: det.relayCount ?? modelRelayCount(model) ?? d.relayCount,
    mac: det.mac ?? d.mac,
    toggleVar: det.options.toggleVar ?? d.toggleVar,
    useHttpFallback: det.options.useHttpFallback ?? d.useHttpFallback,
    transport: det.options.transport ?? d.transport,
  }
}

/** A discovery result → a new-board draft (`/placas/nueva?desde=<key>`). */
export function draftFromDiscovered(b: DiscoveredBoardDTO): BoardDraft {
  const base: BoardDraft = {
    ...emptyDraft(),
    host: b.ip,
    httpPort: String(b.httpPort ?? 80),
    tcpPort: b.tcpPort ? String(b.tcpPort) : "",
    model: b.model,
    moduleId: b.moduleId,
    relayCount: modelRelayCount(b.model) ?? 8,
    mac: b.mac ?? "",
  }
  const withDetect = b.detect ? applyDetect(base, b.detect) : base
  const label = withDetect.model ?? b.hostname ?? "Placa"
  return { ...withDetect, name: `${label} ${b.ip}`.slice(0, 40) }
}

/** Models of the driver's family (dS for the dS drivers, ETH for devantech-eth, all for the simulated one). */
export function modelOptions(driver: DriverId): RelayModelInfo[] {
  if (driver === "devantech-eth") return RELAY_MODELS.filter((m) => m.family === "eth")
  if (driver === "simulated") return [...RELAY_MODELS]
  return RELAY_MODELS.filter((m) => m.family === "ds")
}

/** Picking a model sets the physical relay count and module id (D4). */
export function setModel(d: BoardDraft, model: string | null): BoardDraft {
  const info = modelByName(model)
  return { ...d, model, moduleId: info?.moduleId ?? null, relayCount: info?.relays ?? d.relayCount }
}

/** Changing the driver drops a model of the other family and a TCP port the new driver does not use. */
export function setDriver(d: BoardDraft, driver: DriverId): BoardDraft {
  const keepModel = d.model === null || modelOptions(driver).some((m) => m.model === modelByName(d.model)?.model)
  const next: BoardDraft = { ...d, driver, model: keepModel ? d.model : null, moduleId: keepModel ? d.moduleId : null }
  if (DEFAULT_TCP_PORT[driver] === null && driver !== "simulated") next.tcpPort = ""
  const max = maxRelays(next)
  if (next.relayCount > max) next.relayCount = max
  return next
}

export function usesTcp(driver: DriverId): boolean {
  return DEFAULT_TCP_PORT[driver] !== null
}

export function maxRelays(d: Pick<BoardDraft, "driver" | "model" | "sim">): number {
  return driverCapabilities(d.driver, { model: d.model, options: { sim: d.sim } }).maxRelays
}

export function pulseIsEmulated(d: Pick<BoardDraft, "driver" | "model" | "sim">): boolean {
  return driverCapabilities(d.driver, { model: d.model, options: { sim: d.sim } }).pulse === "emulated"
}

const portOf = (s: string): number | null => (/^\d+$/.test(s.trim()) ? Number(s.trim()) : null)

/** What the connection test depends on: a changed address or port makes an earlier test outdated. */
export function connectionKey(d: Pick<BoardDraft, "host" | "httpPort" | "tcpPort">): string {
  return `${d.host.trim().toLowerCase()}|${portOf(d.httpPort) ?? ""}|${portOf(d.tcpPort) ?? ""}`
}

export interface ConnectionTest { key: string; results: DetectResultDTO[]; fromDiscovery?: boolean }
export type TestGate = "ok" | "required" | "outdated" | "failed"

/**
 * §8.9: "Probar conexión" is required before the first save of a non-simulated board. Editing never requires it.
 * A test counts when it found at least one board at the current address and ports.
 */
export function testGate(mode: "create" | "edit", d: BoardDraft, last: ConnectionTest | null): TestGate {
  if (mode === "edit" || d.driver === "simulated") return "ok"
  if (!last) return "required"
  if (last.key !== connectionKey(d)) return "outdated"
  return last.results.length ? "ok" : "failed"
}

/** The `testBoardConnection` input for the draft (the typed password only; a saved one is never sent back). */
export function connectionInput(d: BoardDraft): {
  driver?: DriverId; host: string; httpPort: number; tcpPort: number | null; username: string | null; password: string | null
} {
  return {
    driver: d.driver === "simulated" ? "simulated" : undefined,
    host: d.host.trim(),
    httpPort: portOf(d.httpPort) ?? 80,
    tcpPort: usesTcp(d.driver) ? portOf(d.tcpPort) : null,
    username: d.username.trim() || null,
    password: d.password || null,
  }
}

function toFieldErrors(issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>): FieldErrors {
  const fe: FieldErrors = {}
  for (const i of issues) (fe[i.path.map(String).join(".") || "_form"] ??= []).push(i.message)
  return fe
}

/**
 * Spanish messages for zod's built-in checks (the contract schemas carry Spanish text only for their custom
 * rules). Schema-level messages still win, so "IP o nombre de host no válido" and "MAC no válida" come through.
 */
export const spanishIssues: z.core.$ZodErrorMap = (iss) => {
  switch (iss.code) {
    case "too_small":
      if (iss.origin === "string") return Number(iss.minimum) <= 1 ? "Obligatorio" : `Mínimo ${iss.minimum} caracteres`
      return `El mínimo es ${iss.minimum}`
    case "too_big":
      return iss.origin === "string" ? `Máximo ${iss.maximum} caracteres` : `El máximo es ${iss.maximum}`
    case "invalid_type":
      return "Obligatorio"
    case "invalid_format":
      return "Formato no válido"
    case "invalid_value":
      return "Valor no válido"
    default:
      return undefined
  }
}

/**
 * The action input, validated with the same schema as the server (dotted field errors, §7.1). Password semantics
 * for updates: `undefined` keeps the saved one, `null` clears it, a string replaces it.
 */
export function draftToInput(d: BoardDraft, mode: "create" | "edit"):
  { ok: true; input: BoardInput } | { ok: false; fieldErrors: FieldErrors } {
  const fe: FieldErrors = {}
  const httpPort = portOf(d.httpPort)
  const tcpPort = d.tcpPort.trim() === "" ? null : portOf(d.tcpPort)
  if (httpPort === null) fe.httpPort = ["Indica un puerto entre 1 y 65535"]
  if (usesTcp(d.driver) && d.tcpPort.trim() !== "" && tcpPort === null) fe.tcpPort = ["Indica un puerto entre 1 y 65535"]
  // Options are never dropped silently: a toggleVar learned for a dS board stays when it moves to ASCII TCP, and the
  // fields only apply to the driver that uses them.
  const options: BoardOptions = {}
  if (d.toggleVar.trim()) options.toggleVar = d.toggleVar.trim()
  if (d.useHttpFallback) options.useHttpFallback = true
  if (d.transport === "http") options.transport = "http"
  if (d.sim) options.sim = d.sim
  const password = d.clearPassword ? null : d.password ? d.password : mode === "create" ? null : undefined
  const raw = {
    name: d.name,
    driver: d.driver,
    host: d.host,
    httpPort: httpPort ?? 80,
    tcpPort: usesTcp(d.driver) ? tcpPort : null,
    model: d.model,
    moduleId: d.moduleId,
    mac: d.mac.trim() ? d.mac.trim() : null,
    relayCount: d.relayCount,
    options,
    username: d.driver === "devantech-eth" && d.username.trim() ? d.username.trim() : null,
    password: d.driver === "devantech-eth" ? password : mode === "create" ? null : d.clearPassword ? null : undefined,
    enabled: d.enabled,
  }
  const parsed = BoardInputSchema.safeParse(raw, { error: spanishIssues })
  if (!parsed.success) Object.assign(fe, toFieldErrors(parsed.error.issues), fe)
  const max = maxRelays(d)
  if (d.relayCount > max) (fe.relayCount ??= []).push(`Este controlador admite como máximo ${max} relés`)
  if (Object.keys(fe).length || !parsed.success) return { ok: false, fieldErrors: fe }
  return { ok: true, input: parsed.data }
}

/** Dirty check for the unsaved-changes guard. */
export function draftEquals(a: BoardDraft, b: BoardDraft): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}
