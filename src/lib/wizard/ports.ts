// Port helpers for the wizard's "Conexiones" step and the Ajustes port dialog (W2-B). Pure; unit-tested.
import type { MatchBy } from "@/lib/contracts/enums"
import type { PortGroup, ProbeResultDTO, ProbeState, SerialPortDTO, SerialSnapshotDTO } from "@/lib/contracts/serial"

export function allPorts(s: SerialSnapshotDTO): SerialPortDTO[] {
  return [...s.adapters.flatMap((a) => a.ports), ...s.others]
}

export function findPort(s: SerialSnapshotDTO, stableKey: string | null | undefined): SerialPortDTO | null {
  if (!stableKey) return null
  return allPorts(s).find((p) => p.stableKey === stableKey) ?? null
}

/** Not assigned to any console, readable, and not held by another program (a preview does not count). */
export function isFreePort(p: SerialPortDTO): boolean {
  return p.assignment === null && p.accessible && p.inUse !== "other"
}

/**
 * The snapshot as the port dialog should label it for a draft that is not saved yet. `holderOf(port)` returns the
 * key of the draft console that will hold the port (shown as "Asignado a <thisEquipment> · KEY"), null when the
 * draft frees a port the server still shows as bound to this equipment ("Libre"), or undefined to keep the port as
 * the server reported it. Only labels change: callers keep deciding what is selectable from the real snapshot.
 */
export function withDraftHolders(
  s: SerialSnapshotDTO,
  holderOf: (p: SerialPortDTO) => string | null | undefined,
  thisEquipment: string,
): SerialSnapshotDTO {
  const relabel = (p: SerialPortDTO): SerialPortDTO => {
    const holder = holderOf(p)
    if (holder === undefined) return p
    if (holder === null) return p.assignment ? { ...p, assignment: null } : p
    return { ...p, assignment: { equipmentId: p.assignment?.equipmentId ?? "", equipmentName: thisEquipment, consoleId: p.assignment?.consoleId ?? "", consoleKey: holder, consoleLabel: holder } }
  }
  return { ...s, adapters: s.adapters.map((a) => ({ ...a, ports: a.ports.map(relabel) })), others: s.others.map(relabel) }
}

/**
 * `holderOf` for `withDraftHolders`. `draftHolder` is the key of the draft console that uses the port (null: none);
 * `ownEquipmentId` is the equipment being edited (null in the wizard). A port that another equipment holds now keeps
 * the server's label, so a conflict that appeared meanwhile is never hidden behind "Asignado a este equipo".
 */
export function draftPortHolder(p: SerialPortDTO, draftHolder: string | null, ownEquipmentId: string | null): string | null | undefined {
  if (p.assignment && p.assignment.equipmentId !== ownEquipmentId) return undefined
  if (draftHolder) return draftHolder
  return p.assignment ? null : undefined
}

/** Live preview is allowed only for present, unbound ports (§4.7); the server refuses the rest with 4004. */
export function isPreviewable(p: SerialPortDTO): boolean {
  return p.assignment === null && p.accessible
}

function basename(path: string): string {
  const i = path.lastIndexOf("/")
  return i >= 0 ? path.slice(i + 1) : path
}

/**
 * Short name of a port, as the channel strip shows it once bound: "FT4ABCDE·B", "USB 3.1·B" (no unique serial),
 * "ttyV0" (virtual or builtin).
 */
export function portShort(p: SerialPortDTO): string {
  if (p.usb) {
    const letter = p.interfaceLetter ?? `if${p.usb.interfaceNumber}`
    const unique = !!p.usb.serial && !p.hints.includes("no-serial") && !p.hints.includes("duplicate-serial")
    return unique ? `${p.usb.serial}·${letter}` : `USB ${p.usb.portPath}·${letter}`
  }
  return basename(p.devNode)
}

/** "B · ttyUSB1" for adapter ports, "ttyV0" for virtual and builtin ports. */
export function portName(p: SerialPortDTO): string {
  return p.usb && p.interfaceLetter ? `${p.interfaceLetter} · ${p.name}` : basename(p.devNode)
}

/** The suggested match mode (same rule as W1-E `suggestedMatchBy`, kept pure here for the draft helpers). */
export function defaultMatchBy(p: SerialPortDTO | null): MatchBy {
  if (!p || !p.usb) return "path"
  return p.hints.includes("no-serial") || p.hints.includes("duplicate-serial") || !p.usb.serial ? "usb-port" : "adapter"
}

/** True when "adapter" would not identify this port reliably (no unique serial). */
export function lacksUniqueSerial(p: SerialPortDTO | null): boolean {
  return !!p?.usb && (p.hints.includes("no-serial") || p.hints.includes("duplicate-serial") || !p.usb.serial)
}

/**
 * The group handed to `suggestMapping` for "Asignar en orden": ports already used by the draft are removed, and a
 * port held only by a live preview (unbound, `inUse: "app"`) counts as free, so opening the preview first does not
 * block the mapping.
 */
export function groupForMapping(g: PortGroup, usedInDraft: ReadonlySet<string>): PortGroup {
  return {
    ...g,
    ports: g.ports
      .filter((p) => !usedInDraft.has(p.stableKey))
      .map((p) => (p.assignment === null && p.inUse === "app" ? { ...p, inUse: null } : p)),
  }
}

/** The group to show first: the one with the most free ports (adapters win ties), or null without groups. */
export function defaultGroupKey(groups: readonly PortGroup[]): string | null {
  let best: { key: string; free: number } | null = null
  for (const g of groups) {
    const free = g.ports.filter(isFreePort).length
    if (!best || free > best.free) best = { key: g.key, free }
  }
  return best?.key ?? null
}

export type ProbeTone = "ok" | "warn" | "danger" | "neutral"
const PROBE_TONE: Record<ProbeState, ProbeTone> = {
  fsbl: "ok", "uboot-autoboot": "ok", "uboot-prompt": "ok", "linux-booting": "ok", login: "ok", shell: "ok", bitreader: "ok",
  unreadable: "warn", silent: "neutral", "busy-other": "warn", "no-permission": "danger", missing: "danger", error: "danger",
}
export const probeTone = (s: ProbeState): ProbeTone => PROBE_TONE[s]

/** stableKey → hostname from identify results, for `reorderByHostname`. */
export function hostnamesOf(results: Readonly<Record<string, ProbeResultDTO>>): Record<string, string | null> {
  return Object.fromEntries(Object.entries(results).map(([k, r]) => [k, r.hostname]))
}

/** The Spanish list "0 (A), 1 (B)" of interfaces a template skips. */
export function interfaceList(skip: readonly number[]): string {
  return [...skip].sort((a, b) => a - b).map((n) => `${n} (${String.fromCharCode(65 + n)})`).join(", ")
}
