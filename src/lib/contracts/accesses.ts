// Network accesses per equipment ("Accesos"): JTAG (hw_server), serial consoles over raw TCP and TCP forwards (Ethernet),
// each on its own fixed TCP port of RM_ACCESS_PORTS; plus the cable inventory ("Cables": named JTAG cables and USB-serial
// adapters). Shared by server and UI.
import { z } from "zod"
import { IdSchema, KeySchema, LabelSchema, type IsoDate } from "./common"
import type { SerialSnapshotDTO } from "./serial"
import type { EquipnetEditDTO, LinkState, NetAdapterDTO } from "./equipnet"

export const ACCESS_KINDS = ["jtag", "serial", "tcp"] as const
export const AccessKindSchema = z.enum(ACCESS_KINDS)
export type AccessKind = z.infer<typeof AccessKindSchema>

/** "reserved": open only while the equipment is reserved. "always": open all the time (serial writes still need a reservation). */
export const ACCESS_POLICIES = ["reserved", "always"] as const
export const AccessPolicySchema = z.enum(ACCESS_POLICIES)
export type AccessPolicy = z.infer<typeof AccessPolicySchema>

export const ACCESS_STATUSES = [
  "stopped", "starting", "listening", "unconfigured", "cable-missing", "hw-server-missing", "console-missing", "network-missing", "port-busy", "error",
] as const
export type AccessStatus = (typeof ACCESS_STATUSES)[number]
/** Why an access is "stopped". */
export type AccessStopReason = "disabled" | "not-reserved" | null

export const CABLE_KINDS = ["jtag", "serial-adapter", "net-adapter"] as const
export const CableKindSchema = z.enum(CABLE_KINDS)
export type CableKind = z.infer<typeof CableKindSchema>

export const PortNumberSchema = z.number({ error: "Indica un número de puerto" }).int("Debe ser un número entero").min(1, "Puerto no válido").max(65535, "Puerto no válido")
const HOSTNAME = /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/
export const TargetHostSchema = z.string().trim().max(253).refine((v) => IPV4.test(v) || HOSTNAME.test(v), "Usa una dirección IPv4 o un nombre de host")
/** A cable serial as sysfs reports it (sanitised): letters, digits and a few separators. */
export const CableSerialSchema = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9._:-]+$/, "Número de serie no válido")
/** A cable label ("JTAG-07", "USB-03"): what is written on the sticker. */
export const CableNameSchema = z.string().trim().min(1, "Obligatorio").max(32, "Como mucho 32 caracteres")
  .regex(/^[\p{L}\p{N}][\p{L}\p{N} ._#/-]*$/u, "Usa letras, números, espacios y . _ # / -")
/** Ethernet access target: "ip" = targetHost:targetPort; "switch" = a port of the equipment switch ("Red de equipos"). */
export const TARGET_MODES = ["switch", "ip"] as const
export const TargetModeSchema = z.enum(TARGET_MODES)
export type TargetMode = z.infer<typeof TargetModeSchema>
export const SwitchPortSchema = z.number({ error: "Elige un puerto del switch" }).int().min(1, "Puerto no válido").max(48, "Puerto no válido")
/** User shown in the ssh/scp commands ("root"). */
export const SshUserSchema = z.string().trim().min(1).max(32).regex(/^[A-Za-z_][A-Za-z0-9_.-]*$/, "Usuario no válido")
/** A cable label identity: JTAG serial, or a serial adapter's "vid:pid:serial" / "loc:<location>", or a network adapter's MAC. */
export const CableIdentitySchema = z.string().trim().min(1).max(200)

/** One access slot of a template (§3.3 + Accesos). No ports: they are given out when an equipment is created.
 * Ethernet slots without a target host default to "switch" mode (the port is chosen per equipment). */
export const TemplateAccessSlotSchema = z.object({
  key: KeySchema,
  label: LabelSchema,
  kind: AccessKindSchema,
  policy: AccessPolicySchema.default("reserved"),
  /** kind "serial": the console key of the same template. */
  consoleKey: KeySchema.nullable().default(null),
  /** kind "tcp": default target (the equipment's own IP is usually set per unit). */
  targetHost: TargetHostSchema.nullable().default(null),
  targetPort: PortNumberSchema.nullable().default(null),
  /** kind "jtag": a cable label to use by default (rarely set on a template). */
  cableName: CableNameSchema.nullable().default(null),
  /** kind "tcp": "switch" (default when there is no target host) or "ip". */
  targetMode: TargetModeSchema.optional(),
  sshUser: SshUserSchema.nullable().default(null),
}).transform((s) => ({ ...s, targetMode: s.targetMode ?? (s.kind === "tcp" && !s.targetHost ? "switch" as const : "ip" as const) }))
export type TemplateAccessSlot = z.infer<typeof TemplateAccessSlotSchema>

/** One access of an equipment in create/update inputs. `port: null` = next free port of the range. */
export const AccessInputSchema = z.object({
  id: IdSchema.optional(),
  key: KeySchema,
  label: LabelSchema,
  kind: AccessKindSchema,
  enabled: z.boolean().default(true),
  policy: AccessPolicySchema.default("reserved"),
  port: PortNumberSchema.nullable().default(null),
  /** kind "jtag": the cable serial. Wins over cableName. */
  cableSerial: CableSerialSchema.nullable().default(null),
  /** kind "jtag": a cable label, resolved to its serial by the server. */
  cableName: CableNameSchema.nullable().default(null),
  /** kind "serial": the key of a console of the same equipment. */
  consoleKey: KeySchema.nullable().default(null),
  targetHost: TargetHostSchema.nullable().default(null),
  targetPort: PortNumberSchema.nullable().default(null),
  /** kind "tcp": "ip" (targetHost:targetPort) or "switch" (switchPort; targetHost null = the equipment IP of "Red de equipos"). */
  targetMode: TargetModeSchema.default("ip"),
  switchPort: SwitchPortSchema.nullable().default(null),
  sshUser: SshUserSchema.nullable().default(null),
})
export type AccessInput = z.infer<typeof AccessInputSchema>

/** Duplicate keys and ports inside one list of accesses (paths `accesses.<i>.key|port`). */
export function refineAccesses(
  accesses: ReadonlyArray<{ key: string; port?: number | null; kind?: AccessKind; consoleKey?: string | null }>,
  ctx: z.RefinementCtx,
  opts: { consoleKeys?: ReadonlyArray<string> } = {},
): void {
  const keys = new Set<string>()
  const ports = new Set<number>()
  const consoles = opts.consoleKeys ? new Set(opts.consoleKeys) : null
  accesses.forEach((a, i) => {
    if (keys.has(a.key)) ctx.addIssue({ code: "custom", path: ["accesses", i, "key"], message: `Clave repetida: ${a.key}` })
    keys.add(a.key)
    if (typeof a.port === "number") {
      if (ports.has(a.port)) ctx.addIssue({ code: "custom", path: ["accesses", i, "port"], message: `Puerto repetido: ${a.port}` })
      ports.add(a.port)
    }
    if (consoles && a.kind === "serial" && a.consoleKey && !consoles.has(a.consoleKey)) {
      ctx.addIssue({ code: "custom", path: ["accesses", i, "consoleKey"], message: `No hay ninguna consola ${a.consoleKey}` })
    }
  })
}

export interface AccessConnectionDTO {
  id: string
  remote: string                            // "192.0.2.20:51234"
  since: IsoDate
  rxBytes: number | null                    // null: not measurable (JTAG, hw_server owns the socket)
  txBytes: number | null
}

export interface AccessRuntimeDTO {
  status: AccessStatus
  reason: AccessStopReason
  detail: string | null                     // Spanish cause and what to do
  since: IsoDate
  connections: AccessConnectionDTO[]
  /** Serial accesses: writing is allowed now (the equipment is reserved and the console is open). */
  writable: boolean
  /** TCP forwards: last reachability probe of the target (null = not probed yet). */
  targetReachable: boolean | null
  pid: number | null
  /** TCP forwards through the equipment switch: port, VLAN and link ("Puerto 3 del switch · enlace activo"). */
  network: AccessNetworkDTO | null
}

export interface AccessNetworkDTO {
  switchPort: number
  vid: number | null
  link: LinkState
  /** "192.168.1.10:22": where the forward connects to, through the port's VLAN. */
  target: string | null
  /** The server's VLAN interface for this port is in place. */
  ready: boolean
}

export interface AccessDTO {
  id: string
  equipmentId: string
  position: number
  key: string
  label: string
  kind: AccessKind
  port: number
  enabled: boolean
  policy: AccessPolicy
  cableSerial: string | null
  /** The cable's label ("JTAG-07"), when it has one. */
  cableName: string | null
  consoleId: string | null
  consoleKey: string | null
  targetHost: string | null
  targetPort: number | null
  targetMode: TargetMode
  switchPort: number | null
  sshUser: string | null
  runtime: AccessRuntimeDTO
}

/** Where a cable is used: a JTAG access (JTAG cables) or a console (USB-serial adapters). */
export interface CableAssignmentDTO { equipmentId: string; equipmentName: string; id: string; key: string; label: string }

export type JtagCableFamily = "digilent" | "xilinx" | "ftdi"
export interface JtagCableDTO {
  /** The cable serial (the hw_server jtag-port-filter value); null when the cable has none (not usable). */
  serial: string | null
  vendorId: string
  productId: string
  manufacturer: string | null
  product: string | null
  family: JtagCableFamily
  location: string                          // "USB 1-3.1"
  labelId: string | null
  labelName: string | null
  assignedTo: CableAssignmentDTO[]
}
export interface JtagSnapshotDTO { scannedAt: IsoDate; cables: JtagCableDTO[] }

export interface CableLabelDTO {
  id: string
  kind: CableKind
  identity: string
  name: string
  notes: string | null
  vendorId: string | null
  productId: string | null
  product: string | null
  firstSeenAt: IsoDate
  lastSeenAt: IsoDate | null
  /** Connected now (JTAG: the cable is detected; serial adapter: the adapter is detected). */
  connected: boolean
  assignedTo: CableAssignmentDTO[]
}

export interface HwServerInfoDTO {
  path: string | null
  version: string | null
  source: "config" | "env" | "path" | "install" | null
  /** Why it is not usable (Spanish), when path is null or not executable. */
  problem: string | null
}

export interface AccessPortRowDTO {
  port: number
  equipmentId: string
  equipmentName: string
  accessId: string
  key: string
  label: string
  kind: AccessKind
  policy: AccessPolicy
  enabled: boolean
  cableSerial: string | null
  cableName: string | null
  runtime: AccessRuntimeDTO
}

export interface AccessSettingsDTO {
  range: { from: number; to: number }
  bind: string
  httpPort: number
  maxConnections: number
}

/** Sistema > Accesos. */
export interface AccessSystemDTO {
  settings: AccessSettingsDTO
  hwServer: HwServerInfoDTO
  ports: AccessPortRowDTO[]
  jtag: JtagSnapshotDTO
  labels: CableLabelDTO[]
}

/** Cables page (admin). */
export interface CablesPageDTO {
  labels: CableLabelDTO[]
  jtag: JtagSnapshotDTO
  serial: SerialSnapshotDTO
  hwServer: HwServerInfoDTO
  /** USB network adapters ("Adaptadores de red"; the equipment network one is labelled ETH-01…). */
  netAdapters: NetAdapterDTO[]
}

/** What the wizard, the equipment settings and the template editor need to edit accesses. */
export interface AccessEditContextDTO {
  settings: AccessSettingsDTO
  /** Ports already used by other equipment (the edited equipment's own ports are not in it). */
  usedPorts: number[]
  jtag: JtagSnapshotDTO
  labels: CableLabelDTO[]
  hwServer: HwServerInfoDTO
  /** "Red de equipos": the switch ports to choose from (null = not available). */
  network: EquipnetEditDTO | null
}

export const CreateCableLabelInputSchema = z.object({
  kind: CableKindSchema,
  identity: CableIdentitySchema,
  name: CableNameSchema,
  notes: z.string().trim().max(200).nullable().default(null),
})
export const UpdateCableLabelInputSchema = z.object({
  labelId: IdSchema,
  name: CableNameSchema,
  notes: z.string().trim().max(200).nullable().default(null),
})
export const CableLabelRefInputSchema = z.object({ labelId: IdSchema })
export const AccessRefInputSchema = z.object({ accessId: IdSchema })
