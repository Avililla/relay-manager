import { z } from "zod"

export const BAUD_RATES = [300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800,
  921600, 1000000, 1500000, 2000000, 3000000, 4000000] as const
export const BaudRateSchema = z.number().int().refine((v) => (BAUD_RATES as readonly number[]).includes(v), "Velocidad no admitida")

export const PARITIES = ["none", "even", "odd", "mark", "space"] as const
export const ParitySchema = z.enum(PARITIES)
export type Parity = z.infer<typeof ParitySchema>
export const DataBitsSchema = z.union([z.literal(5), z.literal(6), z.literal(7), z.literal(8)])
export type DataBits = z.infer<typeof DataBitsSchema>
export const StopBitsSchema = z.union([z.literal(1), z.literal(2)])
export type StopBits = z.infer<typeof StopBitsSchema>
export const FLOW_CONTROLS = ["none", "rtscts", "xonxoff"] as const
export const FlowControlSchema = z.enum(FLOW_CONTROLS)
export type FlowControl = z.infer<typeof FlowControlSchema>
export const ENTER_MODES = ["cr", "lf", "crlf"] as const
export const EnterModeSchema = z.enum(ENTER_MODES)
export type EnterMode = z.infer<typeof EnterModeSchema>
export const MATCH_BY = ["adapter", "usb-port", "path"] as const
export const MatchBySchema = z.enum(MATCH_BY)
export type MatchBy = z.infer<typeof MatchBySchema>
export const CONSOLE_STATUSES = ["unbound", "opening", "open", "missing", "busy", "no-permission", "released", "error"] as const
export const ConsoleStatusSchema = z.enum(CONSOLE_STATUSES)
export type ConsoleStatus = z.infer<typeof ConsoleStatusSchema>
export const RELAY_PURPOSES = ["power", "reset", "mode", "generic"] as const
export const RelayPurposeSchema = z.enum(RELAY_PURPOSES)
export type RelayPurpose = z.infer<typeof RelayPurposeSchema>
export const DRIVER_IDS = ["devantech-ds-http", "devantech-ds-ascii", "devantech-eth", "simulated"] as const
export const DriverIdSchema = z.enum(DRIVER_IDS)
export type DriverId = z.infer<typeof DriverIdSchema>
export const INPUT_CAPTURE_MODES = ["markers", "full"] as const
export const InputCaptureSchema = z.enum(INPUT_CAPTURE_MODES)
export type InputCapture = z.infer<typeof InputCaptureSchema>
/** Colour theme of a user account (D39). `User.theme` is null until the user picks one (dark then). */
export const THEME_PREFS = ["dark", "light", "rosa", "system"] as const
export const ThemePrefSchema = z.enum(THEME_PREFS)
export type ThemePref = z.infer<typeof ThemePrefSchema>
/** A stored `User.theme`: an unknown value reads as "not chosen". */
export function parseAccountTheme(v: unknown): ThemePref | null {
  const r = ThemePrefSchema.safeParse(v)
  return r.success ? r.data : null
}

export const LineSettingsSchema = z.object({
  baudRate: BaudRateSchema,
  dataBits: DataBitsSchema,
  parity: ParitySchema,
  stopBits: StopBitsSchema,
  flowControl: FlowControlSchema,
})
export type LineSettings = z.infer<typeof LineSettingsSchema>
export const DEFAULT_LINE: LineSettings = { baudRate: 115200, dataBits: 8, parity: "none", stopBits: 1, flowControl: "none" }

/** "115200 8N1" */
export function lineSummary(l: LineSettings): string {
  const p: Record<Parity, string> = { none: "N", even: "E", odd: "O", mark: "M", space: "S" }
  return `${l.baudRate} ${l.dataBits}${p[l.parity]}${l.stopBits}`
}
