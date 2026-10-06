// Switch drivers of "Red de equipos". A driver opens a session to one switch; the session reads the state and applies
// one 802.1Q operation at a time (the runner verifies each one by reading back). "manual" has no session: the app only
// shows what to set by hand. Add a driver: implement SwitchSession, register it in ./index.ts.
import type { SwitchDriverId } from "@/lib/contracts/equipnet"
import type { Dot1qState, Dot1qVlan } from "@/lib/equipnet/switch-layout"

export interface SwitchTarget {
  host: string
  /** HTTP port of the management (80; RM_NET_SWITCH_HTTP_PORT for simulators). */
  httpPort: number
  /** Source address (the server's management address on the adapter); null = let the kernel choose. */
  localAddress: string | null
  username: string
  password: string
}

export interface SwitchPortLink { port: number; linkUp: boolean; speed: string | null; enabled: boolean; lag: number }
export interface SwitchInfo { model: string | null; hardware: string | null; firmware: string | null; mac: string | null; portCount: number }

export interface SwitchSession {
  info(): Promise<SwitchInfo>
  links(): Promise<SwitchPortLink[]>
  /** Received packets per port (index port - 1): which port is this server on? */
  rxCounters(): Promise<number[]>
  dot1q(): Promise<Dot1qState>
  /** Is another VLAN mode (port-based, MTU) on? It is switched off when 802.1Q is enabled. */
  otherModes(): Promise<{ portBased: boolean | null; mtu: boolean | null }>
  enableDot1q(on: boolean): Promise<void>
  setVlan(v: Dot1qVlan): Promise<void>
  deleteVlans(vids: number[]): Promise<void>
  setPvid(ports: number[], pvid: number): Promise<void>
  /** Writes the running configuration to flash (it survives a power cycle). */
  save(): Promise<void>
  /** The switch's own configuration backup file, when it offers one. */
  backup(): Promise<Buffer | null>
  close(): Promise<void>
}

export type SwitchErrorCode = "unreachable" | "auth-failed" | "sessions-full" | "protocol" | "rejected"
export class SwitchError extends Error {
  readonly code: SwitchErrorCode
  constructor(code: SwitchErrorCode, message: string) {
    super(message)
    this.name = "SwitchError"
    this.code = code
  }
}

export interface SwitchDriver {
  id: SwitchDriverId
  /** false: no session (manual instructions only). */
  automatic: boolean
  open(target: SwitchTarget): Promise<SwitchSession>
  /** Does this look like one of our switches (the management login page)? Read-only, no credentials. */
  fingerprint(host: string, httpPort: number, localAddress: string | null): Promise<boolean>
}
