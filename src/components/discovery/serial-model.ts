// Descubrimiento > Puertos serie (§8.9): pure view logic over the serial snapshot. No React, no I/O.
import { MATCH_BY, type MatchBy } from "@/lib/contracts/enums"
import type { PortGroup, ProbeState, SerialPortDTO, SerialSnapshotDTO } from "@/lib/contracts/serial"
import type { HealthCheckDTO } from "@/lib/contracts/system"
import { suggestMapping } from "@/lib/serial/mapping"

/** Every port of the snapshot, adapters first (JTAG adapters included). */
export function snapshotPorts(s: SerialSnapshotDTO): SerialPortDTO[] {
  return [...s.adapters.flatMap((a) => a.ports), ...s.others]
}

/** Ports present in `next` and not in `prev` (hot-plugged): their rows get the "Nuevo" highlight. */
export function newPortKeys(prev: SerialSnapshotDTO, next: SerialSnapshotDTO): string[] {
  const before = new Set(snapshotPorts(prev).map((p) => p.stableKey))
  return snapshotPorts(next).map((p) => p.stableKey).filter((k) => !before.has(k))
}

/** Counts over the visible groups (what the page lists). */
export function portCounts(groups: readonly PortGroup[]): { total: number; free: number; assigned: number } {
  const ports = groups.flatMap((g) => g.ports)
  return {
    total: ports.length,
    free: ports.filter(isFreePort).length,
    assigned: ports.filter((p) => p.assignment !== null).length,
  }
}

/**
 * Unassigned, accessible and not held by another program: can be assigned and previewed. A port the app itself
 * holds without a console (a preview or a probe) is free: binding it closes those (§4.7).
 */
export function isFreePort(p: SerialPortDTO): boolean {
  return p.assignment === null && p.accessible && p.inUse !== "other"
}

/** The preview socket refuses bound ports and ports another program holds; previews of one port are shared (§5.7). */
export function canPreview(p: SerialPortDTO): boolean {
  return isFreePort(p)
}

/** "Enviar retorno de carro": only with the policy on, on a free port nobody has open (D3). */
export function canPoke(p: SerialPortDTO, allowPoke: boolean): boolean {
  return allowPoke && isFreePort(p) && p.inUse === null
}

/** Identify is passive: any accessible port (ports the app holds are classified from its own buffer). */
export function canIdentify(p: SerialPortDTO): boolean {
  return p.accessible && p.inUse !== "other"
}

/** "Identificar todos": the group's identifiable ports, at most 16 (the action's limit). */
export function identifyTargets(group: PortGroup): string[] {
  return group.ports.filter(canIdentify).map((p) => p.stableKey).slice(0, 16)
}

export type ProbeTone = "ok" | "warn" | "danger" | "neutral"

/** Chip tone of a probe result: a console that answers is ok; permission and absence are danger. */
export function probeTone(state: ProbeState): ProbeTone {
  switch (state) {
    case "shell":
    case "login":
    case "uboot-prompt":
      return "ok"
    case "unreadable":
    case "busy-other":
      return "warn"
    case "no-permission":
    case "missing":
    case "error":
      return "danger"
    default:
      return "neutral"
  }
}

/** Match modes a port supports: USB ones follow the adapter or the socket; virtual and builtin ports use the path. */
export function allowedMatchBy(p: SerialPortDTO): MatchBy[] {
  if (!p.usb) return ["path"]
  const unique = !!p.usb.serial && !p.hints.includes("no-serial") && !p.hints.includes("duplicate-serial")
  return MATCH_BY.filter((m) => m !== "adapter" || unique)
}

export interface AssignConsole { id: string; key: string; label: string; bound: boolean; adapterShort: string | null }
export interface AssignRow { stableKey: string | null; matchBy: MatchBy }
export type AssignDraft = Record<string, AssignRow>

/**
 * The initial mapping of the assign dialog: `suggestMapping` (W1-A) of the group's free ports (`isFreePort`) onto
 * the unbound consoles, in physical order. Bound consoles are not part of the draft.
 */
export function initialAssignDraft(
  consoles: readonly AssignConsole[],
  group: PortGroup,
  suggestMatchBy: (p: SerialPortDTO) => MatchBy,
): AssignDraft {
  const free: PortGroup = { ...group, ports: group.ports.filter(isFreePort) }
  const byKey = new Map(free.ports.map((p) => [p.stableKey, p]))
  const mapping = suggestMapping(consoles.map((c) => ({ key: c.key, bound: c.bound })), free, { skipInterfaces: [], onlyFree: false })
  const draft: AssignDraft = {}
  consoles.forEach((c) => {
    if (!c.bound) draft[c.id] = { stableKey: null, matchBy: "path" }
  })
  for (const m of mapping) {
    const c = consoles[m.slotIndex]
    const port = byKey.get(m.stableKey)
    if (c && port) draft[c.id] = { stableKey: port.stableKey, matchBy: suggestMatchBy(port) }
  }
  return draft
}

/** Picking a port for one console takes it away from any other console of the draft. */
export function setAssignPort(
  draft: AssignDraft,
  consoleId: string,
  port: SerialPortDTO | null,
  suggestMatchBy: (p: SerialPortDTO) => MatchBy,
): AssignDraft {
  const next: AssignDraft = {}
  for (const [id, row] of Object.entries(draft)) {
    next[id] = port && id !== consoleId && row.stableKey === port.stableKey ? { stableKey: null, matchBy: "path" } : row
  }
  next[consoleId] = port ? { stableKey: port.stableKey, matchBy: suggestMatchBy(port) } : { stableKey: null, matchBy: "path" }
  return next
}

/** The `updateEquipmentBindings` rows for the chosen ports, in console order. Empty when nothing is chosen. */
export function assignBindings(
  consoles: readonly AssignConsole[],
  draft: AssignDraft,
): Array<{ consoleId: string; binding: { stableKey: string; matchBy: MatchBy } }> {
  return consoles.flatMap((c) => {
    const row = draft[c.id]
    return row?.stableKey ? [{ consoleId: c.id, binding: { stableKey: row.stableKey, matchBy: row.matchBy } }] : []
  })
}

/** A one-port pseudo-group, for "Asignar a equipo…" on a single row. */
export function singlePortGroup(group: PortGroup, port: SerialPortDTO): PortGroup {
  return { ...group, key: `${group.key}#${port.stableKey}`, ports: [port] }
}

/** Short display name of a port: "ttyUSB2 · B" for adapters, the pty/link name otherwise. */
export function portDisplayName(p: SerialPortDTO): string {
  const base = p.kind === "virtual" ? p.devNode.split("/").pop() || p.name : p.name
  return p.interfaceLetter && p.usb ? `${base} · ${p.interfaceLetter}` : base
}

/**
 * The serial hints shown under the "No se detectan adaptadores USB-serie" empty state: without the info-level
 * "No hay adaptadores USB-serie conectados" check, which only repeats it (its dmesg/lsusb advice is in the empty
 * state). A devices check that reports a real problem (permissions, Docker mounts) stays.
 */
export function emptyStateHints(checks: readonly HealthCheckDTO[]): HealthCheckDTO[] {
  return checks.filter((c) => !(c.id === "serial.devices" && c.level === "info"))
}
