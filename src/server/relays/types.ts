// Internal relay driver interface (§4.8). Owned by W1-B; not a cross-stream contract.
import type { DriverId } from "@/lib/contracts/enums"
import type { BoardOptions, DetectResultDTO, DriverCapabilitiesDTO } from "@/lib/contracts/relays"
import type { Logger } from "@/server/log"

export interface BoardRef {
  id: string
  name: string
  driver: DriverId
  host: string
  httpPort: number
  tcpPort: number | null
  relayCount: number
  model: string | null
  username: string | null
  password: string | null
  options: BoardOptions
  /** Last persisted state ("0101…", index 0 = channel 1); seeds the simulated driver. */
  relayState: string
}

export interface ProbeContext { signal: AbortSignal; timeoutMs: number; hint?: Partial<DetectResultDTO> }

export interface RelayDriver {
  readonly id: DriverId
  readonly label: string                    // Spanish, shown in the board form
  capabilities(board: Pick<BoardRef, "model" | "options" | "relayCount">): DriverCapabilitiesDTO
  /** MUST be read-only (§4.10 safety). Resolve null when this driver does not match. */
  detect(host: string, ports: { httpPort: number | null; tcpPort: number | null }, ctx: ProbeContext): Promise<DetectResultDTO | null>
  readState(board: BoardRef, signal: AbortSignal): Promise<boolean[]>           // index 0 = channel 1, length relayCount
  setRelay(board: BoardRef, channel: number, on: boolean, signal: AbortSignal): Promise<void>   // 1-based channel
  pulse(board: BoardRef, channel: number, ms: number, signal: AbortSignal): Promise<void>
}

export type RelayDriverErrorKind = "unreachable" | "timeout" | "auth" | "protocol" | "unsupported" | "nack" | "config"

export class RelayDriverError extends Error {
  constructor(message: string, readonly kind: RelayDriverErrorKind) {
    super(message)
    this.name = "RelayDriverError"
  }
}

/** Structural check (never rely on instanceof across module graphs). */
export function isRelayDriverError(e: unknown): e is RelayDriverError {
  if (typeof e !== "object" || e === null) return false
  const o = e as { name?: unknown; kind?: unknown; message?: unknown }
  return o.name === "RelayDriverError" && typeof o.kind === "string" && typeof o.message === "string"
}

// ---------------------------------------------------------------- transports

export interface HttpGetOptions {
  host: string
  port: number
  /** Path plus optional query, e.g. "/index.xml" or "/dscript.cgi?V20944=3". */
  path: string
  timeoutMs: number
  signal?: AbortSignal
  /** Sent as an `Authorization: Basic` header; credentials are never put in the URL. */
  auth?: { username: string; password: string } | null
  maxBytes?: number
}
export interface HttpResponse {
  status: number
  headers: Record<string, string | undefined>
  /** latin1-decoded body, capped at maxBytes (64 KiB). */
  body: string
  truncated: boolean
}
export interface TcpRequestOptions {
  timeoutMs?: number
  /** Resolve with what was received once the line has been idle this long (at least one byte received). */
  idleMs?: number
}
export interface TcpConversation {
  readonly host: string
  readonly port: number
  /** Writes `data` and resolves with the bytes received until `until(buf)` is true (or the idle rule applies). */
  request(data: Uint8Array, until: (buf: Buffer) => boolean, opts?: TcpRequestOptions): Promise<Buffer>
  close(): void
}
export interface TcpConnectOptions { host: string; port: number; timeoutMs: number; signal?: AbortSignal; maxBytes?: number }
export interface RelayTransports {
  httpGet(o: HttpGetOptions): Promise<HttpResponse>
  tcpConnect(o: TcpConnectOptions): Promise<TcpConversation>
  /** Connect-only reachability check (scan step 1). Never throws. */
  tcpProbe(o: { host: string; port: number; timeoutMs: number; signal?: AbortSignal }): Promise<boolean>
}

export interface DriverDeps {
  transports: RelayTransports
  /** Per-request timeout (RM_RELAY_TIMEOUT_MS). */
  timeoutMs: number
  log: Logger
  /** ds-http: persists a learned toggleVar (controller callback, D5). */
  persistOptions?: (boardId: string, options: BoardOptions) => Promise<void>
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}
