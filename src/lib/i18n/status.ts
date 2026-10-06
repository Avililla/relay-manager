import type { ConsoleStatus, DriverId, RelayPurpose } from "@/lib/contracts/enums"
import type { ProbeState, CaptureState } from "@/lib/contracts/serial"
import type { ReservationCause } from "@/lib/contracts/reservations"
import type { HealthGroup, HealthLevel } from "@/lib/contracts/system"

/** Spanish labels for every frozen enum (§8.6). Every stream uses these; nobody redefines them. */
const CONSOLE_STATUS: Record<ConsoleStatus, string> = {
  unbound: "Sin adaptador asignado",
  opening: "Abriendo puerto…",
  open: "Abierta",
  missing: "Adaptador desconectado",
  busy: "En uso por otro programa",
  "no-permission": "Sin permiso (grupo dialout)",
  released: "Puerto soltado",
  error: "Error",
}
export const consoleStatusLabel = (s: ConsoleStatus): string => CONSOLE_STATUS[s]

const PROBE_STATE: Record<ProbeState, string> = {
  fsbl: "FSBL (arranque)",
  "uboot-autoboot": "U-Boot: cuenta atrás",
  "uboot-prompt": "U-Boot: línea de órdenes",
  "linux-booting": "Linux arrancando",
  login: "Pide usuario (login)",
  shell: "Línea de órdenes de Linux",
  bitreader: "BITReader",
  unreadable: "Datos ilegibles (¿velocidad?)",
  silent: "Sin datos",
  "busy-other": "En uso por otro programa",
  "no-permission": "Sin permiso",
  missing: "No conectado",
  error: "Error",
}
export const probeStateLabel = (s: ProbeState): string => PROBE_STATE[s]

const CAPTURE_STATE: Record<CaptureState, string> = {
  active: "Grabando",
  "paused-disk": "Captura en pausa: poco espacio en disco",
  disabled: "Sin captura en esta consola",
  off: "Captura desactivada en el servidor",
}
export const captureStateLabel = (s: CaptureState): string => CAPTURE_STATE[s]

const RESERVATION_CAUSE: Record<ReservationCause, string> = {
  reserve: "Reservado",
  renew: "Reserva mantenida",
  release: "Liberado",
  expire: "Reserva caducada",
  "force-release": "Liberación forzada",
  "user-removed": "Usuario desactivado o borrado",
  "access-lost": "Sin acceso al equipo",
}
export const reservationCauseLabel = (s: ReservationCause): string => RESERVATION_CAUSE[s]

const RELAY_PURPOSE: Record<RelayPurpose, string> = {
  power: "Alimentación",
  reset: "Reinicio",
  mode: "Modo",
  generic: "Genérico",
}
export const relayPurposeLabel = (s: RelayPurpose): string => RELAY_PURPOSE[s]

const DRIVER: Record<DriverId, string> = {
  "devantech-ds-http": "Devantech dS (HTTP)",
  "devantech-ds-ascii": "Devantech dS (ASCII TCP)",
  "devantech-eth": "Devantech ETH",
  simulated: "Simulada",
}
export const driverLabel = (s: DriverId): string => DRIVER[s]

const HEALTH_LEVEL: Record<HealthLevel, string> = { ok: "Correcto", warn: "Aviso", fail: "Fallo", info: "Información" }
export const healthLevelLabel = (s: HealthLevel): string => HEALTH_LEVEL[s]

const HEALTH_GROUP: Record<HealthGroup, string> = {
  runtime: "Ejecución",
  data: "Datos",
  serial: "Puertos serie",
  relays: "Relés",
  accesses: "Accesos",
  network: "Red",
  clock: "Reloj",
  service: "Servicio",
}
export const healthGroupLabel = (s: HealthGroup): string => HEALTH_GROUP[s]
