import { z } from "zod"
import { IdSchema, type IsoDate } from "./common"
import { DriverIdSchema, type DriverId, type RelayPurpose } from "./enums"

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/
const HOSTNAME = /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/
export const HostSchema = z.string().trim().min(1).max(253).refine((v) => IPV4.test(v) || HOSTNAME.test(v), "IP o nombre de host no válido")
export const PortSchema = z.number().int().min(1).max(65535)
export const MacSchema = z.string().trim().toLowerCase().regex(/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/, "MAC no válida")
export const CidrSchema = z.string().regex(/^\d{1,3}(\.\d{1,3}){3}\/(2[2-9]|3[0-2])$/, "Usa una red /22 o más pequeña")

export const BoardOptionsSchema = z.object({
  toggleVar: z.string().regex(/^V\d{1,6}$/, "Formato V<número>, p. ej. V20944").optional(),
  useHttpFallback: z.boolean().optional(),          // ds-ascii: read state via /index.xml
  transport: z.enum(["tcp", "http"]).optional(),    // eth: writes over TCP (default) or io.cgi
  sim: z.object({
    latencyMs: z.number().int().min(0).max(5000).optional(),
    failRate: z.number().min(0).max(1).optional(),
    offline: z.boolean().optional(),
    pulseChannels: z.array(z.number().int().min(1).max(32)).optional(),
    absoluteSet: z.boolean().optional(),
  }).optional(),
})
export type BoardOptions = z.infer<typeof BoardOptionsSchema>

export const BoardInputSchema = z.object({
  name: z.string().trim().min(1).max(40),
  driver: DriverIdSchema,
  host: HostSchema,
  httpPort: PortSchema.default(80),
  tcpPort: PortSchema.nullable().default(null),
  model: z.string().trim().max(40).nullable().default(null),
  moduleId: z.number().int().min(0).max(255).nullable().default(null),
  mac: MacSchema.nullable().default(null),
  relayCount: z.number().int().min(1).max(32),
  options: BoardOptionsSchema.default({}),
  username: z.string().max(64).nullable().default(null),
  password: z.string().max(64).nullable().optional(),   // update: undefined = keep, null = clear
  enabled: z.boolean().default(true),
})
export type BoardInput = z.infer<typeof BoardInputSchema>
export const UpdateBoardInputSchema = BoardInputSchema.extend({ boardId: IdSchema })
export const BoardRefInputSchema = z.object({ boardId: IdSchema })
export const DeleteBoardInputSchema = z.object({ boardId: IdSchema, confirmName: z.string() })
export const SetBoardEnabledInputSchema = z.object({ boardId: IdSchema, enabled: z.boolean() })
export const UpdateBoardHostInputSchema = z.object({ boardId: IdSchema, host: HostSchema })
export const BoardConnectionInputSchema = z.object({
  driver: DriverIdSchema.optional(),
  host: HostSchema,
  httpPort: PortSchema.default(80),
  tcpPort: PortSchema.nullable().default(null),
  username: z.string().max(64).nullable().default(null),
  password: z.string().max(64).nullable().default(null),
})
export type BoardConnectionInput = z.infer<typeof BoardConnectionInputSchema>
export const RelayScanInputSchema = z.object({
  cidrs: z.array(CidrSchema).min(1).max(8).optional(),
  ports: z.array(PortSchema).min(1).max(4).optional(),
})
export type RelayScanInput = z.infer<typeof RelayScanInputSchema>
export const SetRelayInputSchema = z.object({ equipmentId: IdSchema, channelId: IdSchema, on: z.boolean(), confirmed: z.boolean().default(false) })
export const PulseRelayInputSchema = z.object({ equipmentId: IdSchema, channelId: IdSchema, ms: z.number().int().min(19).max(60000), confirmed: z.boolean().default(false) })

export interface DriverCapabilitiesDTO {
  absoluteSet: boolean
  toggle: "native" | "emulated"
  pulse: "native" | "emulated" | "none"
  pulseMs: { min: number; max: number; step: number } | null
  maxRelays: number
}
export interface BoardRuntimeDTO {
  online: boolean | null                    // null = never polled
  lastSeenAt: IsoDate | null
  lastError: string | null
  states: Array<boolean | null>             // index 0 = channel 1
  stale: boolean
  capabilities: DriverCapabilitiesDTO
}
export interface BoardDTO {
  id: string; name: string; driver: DriverId; host: string; httpPort: number; tcpPort: number | null
  model: string | null; moduleId: number | null; mac: string | null; relayCount: number
  options: BoardOptions; username: string | null; hasPassword: boolean; enabled: boolean
  usedChannels: number; equipmentCount: number; runtime: BoardRuntimeDTO
}
export interface BoardDetailDTO extends BoardDTO {
  channels: Array<{
    channel: number
    state: boolean | null
    binding: { equipmentId: string; equipmentName: string; channelId: string; label: string; purpose: RelayPurpose } | null
  }>
}
export interface BoardChoiceDTO { id: string; name: string; model: string | null; relayCount: number; freeChannels: number[]; online: boolean | null }
export interface RelayChannelStateDTO { channelId: string; on: boolean | null; stale: boolean }

export interface DetectResultDTO {
  driver: DriverId; confidence: "high" | "medium" | "low"
  host: string; httpPort: number | null; tcpPort: number | null
  model: string | null; moduleId: number | null; relayCount: number | null
  hostname: string | null; mac: string | null; firmware: string | null
  authRequired: boolean; options: BoardOptions
  evidence: string[]                        // "GET /index.xml -> 32 <RlyN>", "ST -> Module Type: dS378" (ASCII: "→" is outside the font subset, §8.3)
}
export type DiscoverySource = "udp-passive" | "udp-active" | "scan"
export interface DiscoveredBoardDTO {
  key: string                               // mac, or "<ip>:<httpPort>"
  sources: DiscoverySource[]
  firstSeenAt: IsoDate; lastSeenAt: IsoDate
  ip: string; mac: string | null; hostname: string | null
  model: string | null; moduleId: number | null; tcpPort: number | null; httpPort: number | null
  detect: DetectResultDTO | null
  registeredBoardId: string | null; registeredBoardName: string | null
  ipChanged: boolean
  reachable: boolean
  hints: string[]                           // Spanish, e.g. "OUI Microchip"
}
export interface RelayDiscoveryResultDTO {
  runId: string; kind: "udp" | "scan"
  startedAt: IsoDate; finishedAt: IsoDate
  targets: string[]; boards: DiscoveredBoardDTO[]; warnings: string[]
}
