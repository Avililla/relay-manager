import { z } from "zod"
import type { IsoDate } from "./common"
import type { EnterMode, LineSettings } from "./enums"
import type { ConsoleRuntimeDTO } from "./serial"

export const WS_PROTOCOL_VERSION = 1
export const WS_CLOSE = {
  NORMAL: 1000, GOING_AWAY: 1001, INTERNAL: 1011,
  UNAUTHENTICATED: 4001, PROTOCOL: 4002, PASSWORD_CHANGE: 4003, NOT_FOUND: 4004,
  SLOW_CONSUMER: 4008, TOO_MANY_SESSIONS: 4009, SESSION_REVOKED: 4010, CONSOLE_CHANGED: 4011,
} as const
export const WS_LIMITS = {
  maxClientFrameBytes: 65_536, maxInputBytesPerSec: 65_536, historyChunkBytes: 65_536,
  sendHighWaterBytes: 1_048_576, sendLowWaterBytes: 262_144,
  slowConsumerBytes: 8_388_608, slowConsumerGraceMs: 10_000,
  clientPingMs: 20_000, serverPingMs: 30_000,
  handshakeTimeoutMs: 10_000,
  maxSessionsPerUserPerConsole: 4, maxSessionsPerUser: 32, maxSessionsPerServer: 256, maxHandshakesPerUserPerMin: 30,
} as const

export type WsMode = "ro" | "rw"
export interface ViewerPresenceDTO { userId: string; name: string; mode: WsMode }

export type WsServerMsg =
  | { t: "hello"; protocol: 1; kind: "console"; consoleId: string; equipmentId: string; key: string; label: string
      mode: WsMode; runtime: ConsoleRuntimeDTO; line: LineSettings; enterMode: EnterMode; localEcho: boolean
      historyBytes: number; viewers: ViewerPresenceDTO[]; serverNow: IsoDate }
  | { t: "hello"; protocol: 1; kind: "preview"; stableKey: string; devNode: string; baudRate: number
      runtime: ConsoleRuntimeDTO; historyBytes: number; serverNow: IsoDate }
  | { t: "history-end"; bytes: number; truncated: boolean }
  | { t: "status"; runtime: ConsoleRuntimeDTO }
  | { t: "mode"; mode: WsMode; reason: "reserved" | "released" | "expired" | "reserved-by-other" | "force-released" }
  | { t: "viewers"; viewers: ViewerPresenceDTO[] }
  | { t: "gap"; droppedBytes: number }
  | { t: "input-rejected"; reason: "not-holder" | "port-not-open" | "rate-limited" | "too-large" }
  | { t: "cleared"; byName: string }
  | { t: "pong"; at: number; serverNow: IsoDate }
  | { t: "error"; code: string; message: string }

export const WsClientMessageSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("ping"), at: z.number() }),
  z.object({ t: z.literal("break"), ms: z.number().int().min(50).max(2000).default(250) }),
])
export type WsClientMessage = z.infer<typeof WsClientMessageSchema>
