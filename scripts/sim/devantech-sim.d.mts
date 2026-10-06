// Types for scripts/sim/devantech-sim.mjs (used by the Vitest suites).

export type SimModel =
  | "dS1242" | "dS2242" | "dS3484" | "TCP184" | "dS378" | "dS2408" | "dS2824" | "dS2832"
  | "ETH002" | "ETH008" | "ETH484" | "ETH8020"

export interface SimModelInfo { family: "ds" | "eth"; relays: number; moduleId: number; io?: string[] }
export const MODELS: Record<SimModel, SimModelInfo>

export interface SimulatorOptions {
  model?: SimModel
  /** Address every server binds to (and the UDP reply source). Default 127.0.0.1. */
  host?: string
  hostname?: string
  /** HTTP port: 0 = random (default), null/false = disabled. */
  http?: number | null | false
  /** dS ASCII TCP port (dS models): 0 = random, undefined/null/false = disabled. */
  ascii?: number | null | false
  /** ETH binary TCP port (ETH models): 0 = random, undefined/null/false = disabled. */
  eth?: number | null | false
  /** Enable the UDP 30303 responder. */
  udp?: boolean
  udpPort?: number
  /** Where replies go (default 127.255.255.255). */
  replyTo?: string
  udpUnicast?: boolean
  /** IPv4 written into the TLV 0x05 field (default: host). */
  announceIp?: string
  toggleVar?: string
  var?: string
  /** ETH: HTTP Basic user/password. dS: `pass` turns on the web password (permission page). */
  user?: string
  pass?: string
  /** ETH TCP password (0x79). */
  tcpPass?: string
  latency?: number
  failRate?: number
  mac?: string
  /** Relays that pulse instead of toggling on dscript.cgi: { 3: 500 } or "3=500,4=19". */
  pulse?: Record<number, number> | string
  initial?: boolean[]
  log?: false | ((line: string) => void)
}

export type SimRequest =
  | { proto: "http"; method: string | undefined; path: string; query: string }
  | { proto: "ascii"; line: string }
  | { proto: "eth"; bytes: number[] }
  | { proto: "udp"; from: string }

export interface Simulator {
  model: SimModel
  host: string
  hostname: string
  mac: string
  toggleVar: string
  moduleId: number
  relayCount: number
  ports: { http: number | null; ascii: number | null; eth: number | null; udp: number | null }
  /** Every request received, in order (safety tests). */
  requests: SimRequest[]
  /** Relay states, index 0 = relay 1 (32 entries for dS models). */
  state(): boolean[]
  setRelay(n: number, on: boolean): void
  /** Sends an unsolicited announcement (like a power-up). */
  announce(): Promise<void>
  stop(): Promise<void>
}

export function createSimulator(opts?: SimulatorOptions): Promise<Simulator>
