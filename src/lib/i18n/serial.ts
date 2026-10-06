// Spanish strings for serial consoles, discovery, capture and the console WebSocket (W1-A).
import type { MatchBy } from "@/lib/contracts/enums"
import type { SerialHint, SerialPortDTO } from "@/lib/contracts/serial"
import { plural } from "./format"

/** Runtime `detail` shown under a console status (cause + fix hint). */
export const SERIAL_DETAIL = {
  busy: "En uso por otro programa (picocom, BITReader_Tool…)",
  noPermission: "Sin permiso: el usuario del servicio debe pertenecer al grupo dialout",
  noPermissionDocker: "Docker: faltan device_cgroup_rules c 188/166",
  missing: "Adaptador no conectado",
  ambiguous: "Varios adaptadores coinciden",
  disconnected: "Se perdió la conexión con el adaptador",
  invalidBinding: "Asignación no válida: vuelve a asignar el puerto",
  otherAdapterInSocket: "En ese puerto USB hay otro adaptador",
  openError: (msg: string) => `No se pudo abrir el puerto: ${msg}`,
} as const

/** Labels of `serial.changed` events. */
export const serialChangeLabel = {
  adapterAdded: (label: string, ports: number) => `Nuevo adaptador: ${label}, ${plural(ports, { one: "# puerto", other: "# puertos" })}`,
  adapterChanged: (label: string, ports: number) => `Adaptador modificado: ${label}, ${plural(ports, { one: "# puerto", other: "# puertos" })}`,
  adapterRemoved: (label: string) => `Adaptador desconectado: ${label}`,
  portAdded: (devNode: string) => `Nuevo puerto: ${devNode}`,
  portRemoved: (devNode: string) => `Puerto retirado: ${devNode}`,
  rescan: "Escaneo manual de puertos serie",
} as const

const HINT: Record<SerialHint, string> = {
  "no-serial": "Sin nº de serie",
  "duplicate-serial": "Serie duplicado",
  "jtag-probable": "JTAG probable",
  simulated: "Virtual",
  builtin: "Del sistema",
}
export const serialHintLabel = (h: SerialHint): string => HINT[h]

const MATCH_BY: Record<MatchBy, string> = {
  adapter: "Seguir al adaptador (nº de serie)",
  "usb-port": "Seguir al puerto USB",
  path: "Ruta fija",
}
export const matchByLabel = (m: MatchBy): string => MATCH_BY[m]

/** Status chip of a port row in Descubrimiento. */
export function portStatusLabel(p: Pick<SerialPortDTO, "assignment" | "inUse" | "accessible" | "accessError">): string {
  if (p.assignment) return `Asignado a ${p.assignment.equipmentName} · ${p.assignment.consoleKey}`
  if (!p.accessible && p.accessError === "EACCES") return "Sin permiso (dialout)"
  if (!p.accessible && p.accessError === "ENOENT") return "No visible en el contenedor"
  if (p.inUse === "other") return "En uso por otro programa"
  if (p.inUse === "app") return "Abierto por la aplicación"
  return "Libre"
}

/** Close reasons of the console and preview sockets (≤ 123 bytes; see `closeReason`). */
export const WS_REASON = {
  unauthenticated: "Sesión no válida",
  passwordChange: "Cambia tu contraseña para continuar",
  notFound: "Consola no encontrada",
  tooMany: "Demasiadas sesiones",
  revoked: "Sesión revocada",
  expired: "Sesión caducada",
  consoleChanged: "Consola eliminada o reconfigurada",
  shutdown: "Servidor detenido",
  slow: "Conexión demasiado lenta",
  protocol: "Demasiados mensajes no válidos",
  internal: "Error interno",
  previewAdminOnly: "Vista previa solo para administradores",
  previewBound: "El puerto está asignado a una consola",
  previewInUse: "La aplicación ya tiene abierto el puerto",
  previewMissing: "Puerto no encontrado",
  previewBaud: "Velocidad no admitida",
  previewGone: "Puerto desconectado",
  previewIdle: "Vista previa cerrada por inactividad",
  assigned: (equipment: string, key: string) => `Puerto asignado a ${equipment} · ${key}`,
} as const

export const WS_MESSAGE = {
  invalidFrame: "Mensaje no válido",
} as const

/** Lines the capture writer inserts (§4.6). */
export const CAPTURE_MARK = {
  header: (equipment: string, equipmentId: string, key: string, consoleId: string) =>
    `relay-manager captura v1 · equipo ${JSON.stringify(equipment)} (${equipmentId}) · consola ${key} (${consoleId})`,
  opened: (devNode: string, line: string) => `abierto ${devNode} ${line}`,
  closed: "puerto cerrado",
  missing: (detail: string) => `puerto no disponible: ${detail}`,
  released: (by: string, until: string | null) => `puerto soltado por ${by}${until ? ` (hasta ${until})` : ""}`,
  retaken: (by: string) => `puerto retomado por ${by}`,
  cleared: (by: string) => `historial borrado por ${by}`,
  serverStart: "servidor iniciado",
  serverStop: "servidor detenido",
  input: (user: string, n: number) => `>>> ${user}: ${n} bytes`,
} as const

/** Errors of probe/poke/release (DomainError messages). */
export const SERIAL_ERROR = {
  consoleNotFound: "Consola no encontrada",
  deviceNotFound: "Puerto no encontrado: vuelve a escanear",
  deviceBound: "El puerto está asignado a una consola",
  deviceBusy: "La aplicación ya tiene abierto el puerto",
  pokeDisabled: "El envío de retorno de carro está desactivado (RM_SERIAL_ALLOW_POKE=0)",
  ubootCountdown: "Cuenta atrás de U-Boot en curso: no se envía nada",
  notHolder: "Solo quien tiene la reserva puede hacerlo",
  reservedByOther: "El equipo está reservado por otra persona: libera su reserva primero",
} as const

/** Server log lines (component "serial" / "capture" / "ws"). */
export const SERIAL_LOG = {
  opened: "Consola abierta",
  openFailed: "No se pudo abrir la consola",
  closedUnexpectedly: "La consola se cerró inesperadamente",
  released: "Puerto soltado",
  retaken: "Puerto retomado",
  capturePaused: "Captura en pausa: poco espacio en disco",
  captureResumed: "Captura reanudada",
  captureWriteError: "Error al escribir la captura",
  retention: "Retención de capturas",
  watchFailed: "No se puede vigilar el directorio: solo sondeo",
  discovery: "Cambio en los puertos serie",
} as const
