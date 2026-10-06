import { z } from "zod"
import { IdSchema, type IsoDate } from "./common"
import { BaudRateSchema, MatchBySchema, type ConsoleStatus } from "./enums"
import type { HealthCheckDTO } from "./system"

export const SERIAL_HINTS = ["no-serial", "duplicate-serial", "jtag-probable", "simulated", "builtin"] as const
export type SerialHint = (typeof SERIAL_HINTS)[number]

export interface UsbInfoDTO {
  vendorId: string; productId: string
  manufacturer: string | null; product: string | null; serial: string | null
  interfaceNumber: number; interfaceName: string | null; portNumber: number
  idPath: string | null; portPath: string; busnum: number; devnum: number
}

export interface SerialPortDTO {
  stableKey: string
  name: string                              // "ttyUSB2"
  devNode: string                           // canonical "/dev/ttyUSB2" (host view) or literal virtual path
  kind: "usb" | "pci" | "platform" | "virtual"
  driver: string | null
  byId: string | null                       // canonical /dev/serial/by-id/...
  byPath: string | null
  usb: UsbInfoDTO | null
  interfaceLetter: string | null            // "A".."D" (multi-interface) or "if<N>"
  accessible: boolean
  accessError: string | null                // "EACCES" | "ENOENT" | ...
  hints: SerialHint[]
  assignment: { equipmentId: string; equipmentName: string; consoleId: string; consoleKey: string; consoleLabel: string } | null
  inUse: "app" | "other" | null
}

export interface UsbAdapterDTO {
  locationKey: string                       // "pci-0000:00:14.0-usb-0:3.1"
  identityKey: string | null                // "0403:6011:FT4ABCDE" or null (no/duplicate serial)
  vendorId: string; productId: string
  manufacturer: string | null; product: string | null; serial: string | null
  label: string                             // "FTDI Quad RS232-HS (FT4ABCDE)", or "USB-03 · FTDI Quad…" when labelled ("Cables")
  labelName?: string | null                 // the cable label ("USB-03"), when it has one
  location: string                          // "USB 1-3.1"
  hints: SerialHint[]
  ports: SerialPortDTO[]                    // ordered by (interfaceNumber, portNumber)
}

export interface SerialSnapshotDTO {
  scannedAt: IsoDate
  adapters: UsbAdapterDTO[]
  others: SerialPortDTO[]                   // virtual and builtin
  hiddenJtag: number
  watcher: { inotify: boolean; intervalMs: number }
}

/** A pickable group of ports: a USB adapter, or the pseudo-group of virtual and builtin ports. */
export interface PortGroup { key: string; label: string; adapter: UsbAdapterDTO | null; ports: SerialPortDTO[] }
/** USB adapters first (snapshot order), then one pseudo-group for `others` when non-empty. */
export function portGroups(s: SerialSnapshotDTO, opts: { showJtag: boolean }): PortGroup[] {
  const groups: PortGroup[] = s.adapters
    .filter((a) => opts.showJtag || !a.hints.includes("jtag-probable"))
    .map((a) => ({ key: a.locationKey, label: `${a.label} · ${a.location}`, adapter: a, ports: a.ports }))
  if (s.others.length) groups.push({ key: "others", label: "Puertos virtuales y del sistema", adapter: null,
    ports: [...s.others].sort((x, y) => x.devNode.localeCompare(y.devNode, "es", { numeric: true })) })
  return groups
}

/** Descubrimiento > Puertos serie page data (W1-A `getSerialPageData`). */
export interface SerialPageDTO {
  snapshot: SerialSnapshotDTO
  serialHints: HealthCheckDTO[]             // only SERIAL_HINT_CHECKS (system.ts)
  allowPoke: boolean
  hideJtag: boolean
}

const devPath = (prefixes: readonly string[]) => z.string().max(300).refine(
  (v) => prefixes.some((p) => v.startsWith(p)), "Ruta de dispositivo no permitida")
/** Persisted binding columns of SerialConsole (canonical host paths). Paths are never opened directly (§4.4). */
export const ConsoleBindingRecordSchema = z.object({
  matchBy: MatchBySchema,
  bindingKey: z.string().min(1).max(300),
  byId: devPath(["/dev/serial/by-id/"]).nullable(),
  byPath: devPath(["/dev/serial/by-path/"]).nullable(),
  usbVendorId: z.string().regex(/^[0-9a-f]{4}$/).nullable(),
  usbProductId: z.string().regex(/^[0-9a-f]{4}$/).nullable(),
  usbSerial: z.string().max(64).nullable(),
  usbInterface: z.number().int().min(0).max(255).nullable(),
  usbPortNumber: z.number().int().min(0).max(255).nullable(),
  usbIdPath: z.string().max(200).nullable(),
  // "/dev/" or an allowed extra-glob directory; the loader-level allow-list (§2.4) is re-checked at resolve time
  devicePath: devPath(["/dev/", "/run/relay-manager/", "/run/user/"]).or(z.string().regex(/^\/.+\/sim\/[^/]+$/)).nullable(),
  adapterLabel: z.string().max(120).nullable(),
  lastDevNode: devPath(["/dev/", "/run/relay-manager/", "/run/user/"]).or(z.string().regex(/^\/.+\/sim\/[^/]+$/)).nullable(),
})
export type ConsoleBindingRecord = z.infer<typeof ConsoleBindingRecordSchema>

export interface ConsoleRuntimeDTO {
  status: ConsoleStatus
  devNode: string | null
  detail: string | null                     // Spanish cause + fix hint
  since: IsoDate
  lastRxAt: IsoDate | null
  lastLine: string | null                   // printable, ANSI stripped, ≤160 chars
  viewers: number
  released: { byName: string; at: IsoDate; until: IsoDate | null } | null
  capture: "active" | "paused-disk" | "disabled" | "off"
}

export const PROBE_STATES = ["fsbl", "uboot-autoboot", "uboot-prompt", "linux-booting", "login", "shell", "bitreader",
  "unreadable", "silent", "busy-other", "no-permission", "missing", "error"] as const
export type ProbeState = (typeof PROBE_STATES)[number]
export interface ProbeResultDTO {
  stableKey: string; devNode: string | null; state: ProbeState; hostname: string | null
  openByApp: boolean                        // classified from the app's own buffer; the port was not reopened
  poked: boolean; sample: string; error: string | null; ms: number
}

export interface CaptureFileDTO {
  name: string; date: string; sizeBytes: number; compressed: boolean; modifiedAt: IsoDate
  input: boolean                            // true for ".input.log" (typed text; admins only)
}
export const CaptureFileNameSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}(\.\d+)?(\.input)?\.log(\.gz)?$/)
export type CaptureState = ConsoleRuntimeDTO["capture"]

export const StableKeySchema = z.string().min(3).max(300)
export const IdentifyPortsInputSchema = z.object({
  stableKeys: z.array(StableKeySchema).min(1).max(16),
  baudRate: BaudRateSchema.default(115200),
  listenMs: z.number().int().min(500).max(10000).default(3000),
})
export const PokePortInputSchema = z.object({ stableKey: StableKeySchema, baudRate: BaudRateSchema.default(115200), confirmed: z.literal(true) })
export const ConsoleRefInputSchema = z.object({ consoleId: IdSchema })
export const ReleaseConsoleInputSchema = z.object({
  consoleId: IdSchema,
  durationMin: z.union([z.literal(15), z.literal(30), z.literal(60), z.literal(240), z.null()]),
})
