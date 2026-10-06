// Pure view model of the accesses (status tone and label, live merge, counts). Unit-tested.
import type { AccessDTO, AccessKind, AccessRuntimeDTO, AccessStatus } from "@/lib/contracts/accesses"
import type { ServerEvent } from "@/lib/contracts/events"
import { ACCESS_STATUS_LABEL, sessionText } from "@/lib/i18n/accesses"

export type AccessTone = "ok" | "warn" | "danger" | "brand" | "neutral"

const TONE: Record<AccessStatus, AccessTone> = {
  listening: "ok",
  starting: "brand",
  stopped: "neutral",
  unconfigured: "warn",
  "cable-missing": "warn",
  "console-missing": "warn",
  "network-missing": "warn",
  "hw-server-missing": "danger",
  "port-busy": "danger",
  error: "danger",
}

export function accessTone(rt: AccessRuntimeDTO): AccessTone {
  return TONE[rt.status]
}

export function accessStatusLabel(rt: AccessRuntimeDTO): string {
  if (rt.status === "stopped" && rt.reason === "disabled") return "Desactivado"
  return ACCESS_STATUS_LABEL[rt.status]
}

/** access.status events of this equipment update the matching row. */
export function reduceAccesses<A extends Pick<AccessDTO, "id" | "runtime">>(list: A[], e: ServerEvent, equipmentId: string): A[] {
  if (e.type !== "access.status" || e.equipmentId !== equipmentId) return list
  let hit = false
  const next = list.map((a) => {
    if (a.id !== e.accessId) return a
    hit = true
    return { ...a, runtime: e.runtime }
  })
  return hit ? next : list
}

export function openCount(list: readonly AccessDTO[]): number {
  return list.filter((a) => a.runtime.status === "listening").length
}

/** Some access opens only with a reservation and the equipment has none: say so above the list. */
export function waitingForReservation(list: readonly AccessDTO[]): boolean {
  return list.some((a) => a.runtime.status === "stopped" && a.runtime.reason === "not-reserved")
}

/** What a remote session is, by access kind: JTAG peers are xsdb/xsct or Vivado talking to hw_server. */
const SESSION_TOOL: Record<AccessKind, string> = { jtag: "xsdb/Vivado", serial: "terminal", tcp: "ssh/Ethernet" }

export interface RemoteSession {
  id: string
  accessId: string
  accessKey: string
  accessLabel: string
  kind: AccessKind
  /** The client address without the port ("172.16.0.5", "fe80::1"). */
  host: string
  since: string
  tool: string
  /** What releasing the reservation does to it: the port closes, the console turns read-only, or nothing. */
  onRelease: "closed" | "read-only" | "kept"
  /** "JTAG SEC: en uso por xsdb/Vivado desde 172.16.0.5". */
  text: string
}

export function remoteHost(remote: string): string {
  return remote.replace(/:\d+$/, "").replace(/^\[|\]$/g, "")
}

/**
 * Established remote sessions on the accesses of one equipment (live `access.status`). They keep the reservation
 * alive; the reservation control shows them and asks before a release or a forced release cuts them.
 */
export function remoteSessions(list: ReadonlyArray<Pick<AccessDTO, "id" | "key" | "label" | "kind" | "policy" | "runtime">>): RemoteSession[] {
  return list.flatMap((a) => a.runtime.connections.map((c) => {
    const host = remoteHost(c.remote)
    const tool = SESSION_TOOL[a.kind]
    return {
      id: `${a.id}:${c.id}`, accessId: a.id, accessKey: a.key, accessLabel: a.label, kind: a.kind, host, since: c.since, tool,
      onRelease: a.policy === "reserved" ? "closed" : a.kind === "serial" ? "read-only" : "kept",
      text: sessionText.line(a.label, tool, host),
    } satisfies RemoteSession
  }))
}
