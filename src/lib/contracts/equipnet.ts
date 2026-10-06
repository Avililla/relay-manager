// "Red de equipos": every equipment has the same fixed IP on its Ethernet; each one is plugged into its own port of a
// small managed switch (TP-Link Easy Smart), each port is its own 802.1Q VLAN, and the server reaches each VLAN through
// a VLAN interface of a USB network adapter with policy routing. Shared by server and UI (zod + DTOs).
import { z } from "zod"
import type { IsoDate } from "./common"
import { isIPv4, parseCidr } from "@/lib/equipnet/ipv4"
import { planEquipnet } from "@/lib/equipnet/plan"

export const SWITCH_DRIVERS = ["tplink-easy-smart", "manual"] as const
export const SwitchDriverSchema = z.enum(SWITCH_DRIVERS)
export type SwitchDriverId = z.infer<typeof SwitchDriverSchema>

export const MacSchema = z.string().trim().toLowerCase().regex(/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/, "MAC no válida (aa:bb:cc:dd:ee:ff)")
export const IPv4Schema = z.string().trim().refine(isIPv4, "Usa una dirección IPv4 (p. ej. 192.168.1.10)")
export const CidrSchema = z.string().trim().refine((v) => parseCidr(v) !== null, "Usa una dirección con prefijo (p. ej. 192.168.0.250/24)")
/** TP-Link Easy Smart: user and password up to 16 characters, printable ASCII. */
export const SwitchUserSchema = z.string().trim().min(1, "Obligatorio").max(16, "Como mucho 16 caracteres").regex(/^[\x21-\x7e]+$/, "Sin espacios ni acentos")
export const SwitchPasswordSchema = z.string().min(1, "Obligatorio").max(16, "Como mucho 16 caracteres").regex(/^[\x20-\x7e]+$/, "Sin acentos ni caracteres especiales")

/**
 * What an admin can change (Sistema › Red de equipos › Ajustes). `switchPassword`: undefined keeps it, null clears it.
 * The interface of the switch is not here: it is chosen on its own (ChooseAdapterInputSchema), with its confirmation.
 */
export const EquipnetSettingsInputSchema = z.object({
  enabled: z.boolean(),
  driver: SwitchDriverSchema,
  switchHost: IPv4Schema.nullable(),
  switchUsername: SwitchUserSchema.nullable(),
  switchPassword: SwitchPasswordSchema.nullable().optional(),
  portCount: z.number().int().min(2, "Mínimo 2 puertos").max(48, "Como mucho 48 puertos"),
  uplinkPort: z.number().int().min(1),
  vlanBase: z.number().int().min(2, "Mínimo 2").max(4000, "Como mucho 4000"),
  mgmtAddress: CidrSchema,
  equipmentIp: IPv4Schema,
  equipmentPrefix: z.number().int().min(8, "Entre 8 y 30").max(30, "Entre 8 y 30"),
  hostOffset: z.number().int().min(1).max(4000),
}).superRefine((v, ctx) => {
  const plan = planEquipnet(v)
  for (const [path, msgs] of Object.entries(plan.errors)) for (const message of msgs) ctx.addIssue({ code: "custom", path: [path], message })
  if (v.driver === "tplink-easy-smart" && v.enabled && !v.switchHost) ctx.addIssue({ code: "custom", path: ["switchHost"], message: "Indica la IP del switch (o búscalo)" })
})
export type EquipnetSettingsInput = z.infer<typeof EquipnetSettingsInputSchema>

/** "Preparar switch" from the detection card: only the password (the rest comes from the detection and the defaults). */
export const PrepareSwitchInputSchema = z.object({
  password: SwitchPasswordSchema.optional(),
  username: SwitchUserSchema.optional(),
})
export const SwitchJobKindSchema = z.enum(["apply", "restore", "remove"])
export type SwitchJobKind = z.infer<typeof SwitchJobKindSchema>
/** Preview first; applying needs the plan id of that preview (the switch must not have changed meanwhile). */
export const SwitchPreviewInputSchema = z.object({ kind: SwitchJobKindSchema })
export const SwitchApplyInputSchema = z.object({
  kind: SwitchJobKindSchema,
  planId: z.string().regex(/^[a-f0-9]{16,64}$/),
  confirmed: z.literal(true),
  /** The uplink could not be verified from the port counters and the admin states the server is on it. */
  uplinkConfirmed: z.boolean().default(false),
})
/** «Buscar el switch» on the chosen interface: a sweep of its management network, or only the IP the admin typed. */
export const DiscoverSwitchInputSchema = z.object({ host: IPv4Schema.optional() })
/**
 * Step 1, «Usar esta»: the interface wired to the switch (null = stop using the current one). `confirmed` is the extra
 * confirmation an interface with a warning needs (another network's address, not USB…).
 */
export const ChooseAdapterInputSchema = z.object({ mac: MacSchema.nullable(), confirmed: z.boolean().default(false) })

// ---------------------------------------------------------------------------------------------------------------------
// DTOs

export interface EquipnetSettingsDTO {
  enabled: boolean
  adapterMac: string | null
  driver: SwitchDriverId
  switchHost: string | null
  switchUsername: string | null
  hasPassword: boolean
  portCount: number
  uplinkPort: number
  vlanBase: number
  mgmtAddress: string
  equipmentIp: string | null
  equipmentPrefix: number
  hostOffset: number
}

/** A physical network interface of the server (sysfs), as listed in «Elige la interfaz del switch». */
export interface NetAdapterDTO {
  ifname: string
  mac: string
  usb: boolean
  bus: "usb" | "pci" | "other"
  wireless: boolean
  driver: string | null
  vendorId: string | null
  productId: string | null
  manufacturer: string | null
  product: string | null
  location: string | null                 // "USB 2-3"
  carrier: boolean | null
  speedMbps: number | null
  addresses: string[]                     // "198.51.100.118/24" (IPv4, global)
  defaultRoute: boolean
  /** NetworkManager's state ("connected", "unmanaged"…) and connection, when nmcli is available. */
  nmState: string | null
  nmConnection: string | null
  /** "yes": can be chosen; "confirm": only with an extra confirmation (see `warning`); "no": never (see `problem`). */
  selectable: "yes" | "confirm" | "no"
  /** Why it cannot be the equipment network interface (Spanish), or null. */
  problem: string | null
  /** Why choosing it needs an extra confirmation (Spanish), or null. */
  warning: string | null
  /** An address it already has in the switch management network, reused as is (nothing is added), or null. */
  mgmtReuse: string | null
  labelId: string | null
  labelName: string | null
  chosen: boolean
}

/** Any other interface of the server (virtual: bridges, docker, VPN…), listed read-only. */
export interface OtherIfaceDTO {
  ifname: string
  kind: string | null                     // "bridge", "veth", "wireguard"… (ip -d link)
  up: boolean
  addresses: string[]
  defaultRoute: boolean
}

/** How the server talks to the switch on the chosen interface. */
export interface MgmtStatusDTO {
  /** "own": the app's address (noprefixroute + its own rule); "reuse": an address the interface already had; "none". */
  mode: "own" | "reuse" | "none"
  address: string | null                  // "192.168.0.250/24"
  subnet: string | null                   // what «Buscar el switch» sweeps
  ifname: string | null
  ready: boolean
  problem: string | null
}

export type HostNetState = "off" | "ok" | "pending" | "no-permission" | "no-adapter" | "no-ip-tool" | "blocked" | "error"
export interface HostNetStatusDTO {
  state: HostNetState
  detail: string | null
  /** `ip …` commands still missing on the server (to run as root when the service cannot). */
  pending: string[]
  canApply: boolean
  ifname: string | null
  /** NetworkManager must leave the adapter alone: null = fine, else the command to run once as root. */
  networkManagerHint: string | null
  checkedAt: IsoDate | null
}

export type SwitchState = "unconfigured" | "manual" | "checking" | "ok" | "unreachable" | "auth-failed" | "error"
export interface SwitchInfoDTO { model: string | null; hardware: string | null; firmware: string | null; mac: string | null; portCount: number | null }
export interface SwitchStatusDTO {
  state: SwitchState
  detail: string | null
  info: SwitchInfoDTO
  /** 802.1Q: null = unknown; `matches` false = the switch differs from what the app set up (details in `drift`). */
  dot1qEnabled: boolean | null
  matches: boolean | null
  drift: string[]
  checkedAt: IsoDate | null
}

export type LinkState = "up" | "down" | "unknown"
export interface SwitchPortUseDTO { equipmentId: string; equipmentName: string; accessId: string; key: string }
export interface SwitchPortDTO {
  port: number
  role: "uplink" | "equipment"
  vid: number | null
  ifname: string | null
  hostAddress: string | null
  link: LinkState
  speed: string | null                    // "1000 Mb/s dúplex"
  /** When the link last came up (as seen by this server); for "Acabas de conectar algo al puerto 4". */
  linkUpAt: IsoDate | null
  usedBy: SwitchPortUseDTO[]
  /** The server side (VLAN interface, address, route) is in place. */
  hostReady: boolean
}

/** The switch found on the chosen interface («Buscar el switch»). */
export interface SwitchDetectionDTO {
  host: string
  adapterMac: string
  adapterIfname: string
  adapterLabel: string                    // "ETH-01" (the label, or the one it will get)
  model: string | null                    // "TL-SG108E" when the factory/stored credentials worked
  portCount: number | null
  loginOk: boolean | null
  at: IsoDate
}

export interface SwitchJobDTO {
  id: string
  kind: SwitchJobKind
  state: "running" | "done" | "failed"
  step: number
  total: number
  label: string
  error: string | null
  warnings: string[]
  startedAt: IsoDate
  endedAt: IsoDate | null
}

export interface EquipnetStatusDTO {
  settings: EquipnetSettingsDTO
  adapters: NetAdapterDTO[]
  host: HostNetStatusDTO
  switch: SwitchStatusDTO
  ports: SwitchPortDTO[]
  /** Read-only list of the other (virtual) interfaces. */
  otherInterfaces: OtherIfaceDTO[]
  mgmt: MgmtStatusDTO
  /** Situations that work but the admin should know (another interface on the equipment network, ARP…). */
  warnings: string[]
  /** What older versions left on interfaces the app may not touch on its own, and the commands that remove it. */
  leftovers: { items: string[]; commands: string[] }
  detection: SwitchDetectionDTO | null
  /** Passive card on Banco / Descubrimiento: interfaces not configured yet (or leftovers); links to Sistema. */
  offerSetup: boolean
  job: SwitchJobDTO | null
  appliedAt: IsoDate | null
  previousAt: IsoDate | null
  hasBackup: boolean
  /** RM_NET_HOST=off: the app never changes the server's network (only shows the commands). */
  hostMode: "apply" | "off"
}

export interface SwitchPortPlanDTO {
  port: number
  role: "uplink" | "equipment"
  before: { pvid: number | null; vlans: string }
  after: { pvid: number | null; vlans: string }
}
export interface SwitchPreviewDTO {
  kind: SwitchJobKind
  planId: string
  /** "Se va a cambiar…": one Spanish sentence per change, in the order they are applied. */
  changes: string[]
  ports: SwitchPortPlanDTO[]
  uplinkCheck: { detected: number | null; expected: number; ok: boolean; detail: string }
  warnings: string[]
  /** Why it cannot be applied (Spanish), or null. */
  blocked: string | null
  nothingToDo: boolean
}

/** What the access editors need (wizard, equipment settings): the switch ports and the equipment IP. */
export interface EquipnetEditDTO {
  configured: boolean
  equipmentIp: string | null
  /** Default port of a new Ethernet access (RM_EQUIPNET_EQUIPMENT_PORT, 22). */
  equipmentPort: number
  portCount: number
  uplinkPort: number
  ports: SwitchPortDTO[]
  /** A free port whose link came up in the last minutes: "Acabas de conectar algo al puerto 4". */
  suggestedPort: number | null
}

/** Manual driver (or when the automatic setup fails): what to set on the switch, port by port. */
export interface ManualInstructionsDTO {
  rows: Array<{ port: number; role: "uplink" | "equipment"; pvid: number; untagged: number[]; tagged: number[] }>
  vlans: Array<{ vid: number; name: string; untagged: number[]; tagged: number[] }>
  notes: string[]
}
