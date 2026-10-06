import type { DriverId } from "@/lib/contracts/enums"
import type { DiscoverySource } from "@/lib/contracts/relays"

/**
 * Spanish copy for relay boards, relay drivers and relay discovery (W1-B).
 * Driver names and relay purposes are in `status.ts` (W0); this module holds everything else.
 */

/** One-line explanation per driver, for the board form radio cards (§8.9 Placas de relés). */
const DRIVER_HELP: Record<DriverId, string> = {
  "devantech-ds-http": "Placas dS con la aplicación de fábrica, por la página web (puerto 80). Solo conmuta: el servidor lee, compara y conmuta.",
  "devantech-ds-ascii": "Placas dS por órdenes de texto TCP (puerto 17123, opción de fábrica). Encendido y apagado directos y pulsos nativos.",
  "devantech-eth": "Placas ETH002, ETH008, ETH484 y ETH8020 por TCP binario (puerto 17494), con contraseña TCP opcional.",
  simulated: "Placa simulada dentro del servidor, para pruebas sin hardware (requiere RM_RELAY_SIMULATE=1).",
}
export const driverHelp = (d: DriverId): string => DRIVER_HELP[d]

/** Placeholder for the TCP port field, per driver. */
const TCP_PORT_PLACEHOLDER: Record<DriverId, string> = {
  "devantech-ds-http": "No se usa",
  "devantech-ds-ascii": "17123",
  "devantech-eth": "17494",
  simulated: "No se usa",
}
export const tcpPortPlaceholder = (d: DriverId): string => TCP_PORT_PLACEHOLDER[d]

const SOURCE: Record<DiscoverySource, string> = { "udp-passive": "UDP pasivo", "udp-active": "UDP", scan: "Escaneo" }
export const discoverySourceLabel = (s: DiscoverySource): string => SOURCE[s]

export const RELAY_TEXT = {
  // Relay state (never colour alone, §8.6)
  stateOn: "ON",
  stateOff: "OFF",
  stateUnknown: "?",
  // Board status (§8.9 Placas: Conectada / Sin respuesta desde … / Desactivada)
  boardOnline: "Conectada",
  boardOffline: "Sin respuesta",
  boardNeverPolled: "Sin leer todavía",
  boardDisabled: "Desactivada",
  boardOfflineSince: (when: string) => `Sin respuesta desde ${when}`,
  boardNoAnswer: (host: string) => `Placa ${host} sin respuesta`,
  pulseEmulatedWarning: "Pulso emulado: si el servidor se detiene a mitad, el relé puede quedar cambiado",
  pulseNotSupported: "Esta placa no admite pulsos",
  pulseRange: (min: number, max: number) => `La duración del pulso debe estar entre ${min} y ${max} ms`,
  pulseStep: (min: number, max: number, step: number) =>
    `La duración del pulso debe estar entre ${min} y ${max} ms, en pasos de ${step} ms`,
  channelFree: "Libre",
  simEvidence: "Placa simulada dentro del servidor (sin red)",
  channelLabel: (n: number) => `Canal ${n}`,

  // Driver errors (RelayDriverError messages; shown to the user as the action error)
  errUnrecognised: "Respuesta no reconocida: ¿es una placa Devantech?",
  errToggleVarMissing: "Falta la variable dScript (toggleVar): indícala en la placa",
  errTcpPassword: "Contraseña TCP incorrecta",
  errTcpPasswordMissing: "La placa pide contraseña TCP: indícala en la configuración de la placa",
  errHttpAuth: "Usuario o contraseña HTTP incorrectos",
  errNack: "La placa ha rechazado la orden",
  errUnknownRelay: (n: number) => `La placa no tiene el relé ${n}`,
  errUnknownAction: "La placa no ha entendido la orden",
  errPulseTooShort: "Pulso demasiado corto: la placa ignora los pulsos de 4 a 18 ms",
  errTimeout: (host: string) => `La placa ${host} no ha respondido a tiempo`,
  errTimeoutGeneric: "La placa no ha respondido a tiempo",
  errUnreachable: (host: string, port: number, code: string) => `No se puede conectar con ${host}:${port} (${code})`,
  errClosed: "La placa ha cerrado la conexión antes de responder",
  errTooLarge: "Respuesta demasiado grande: no parece una placa Devantech",
  errBadHost: "Dirección de la placa no válida",
  errHttpStatus: (status: number) => `La placa ha respondido con el código HTTP ${status}`,
  errSimOffline: "Placa simulada sin conexión",
  errSimFailure: "Fallo simulado de la placa",
  errPulseIncomplete: "Pulso emulado incompleto: el relé puede haber quedado cambiado",
  errAborted: "Operación cancelada: el servidor se está deteniendo",
  errPulseInterrupted: (label: string) =>
    `El pulso del relé ${label} se ha interrumpido porque el servidor se está deteniendo: comprueba su estado`,
  /** Audit detail `error` of a relay.pulse cut short. */
  auditPulseInterrupted: "interrumpido",

  // Controller errors (DomainError messages)
  errNotChanged: (label: string) =>
    `El relé ${label} no cambió de estado: puede estar configurado como pulso o gobernado por una ecuación en la placa`,
  errBoardFailed: (board: string, detail: string) => `La placa ${board} ha fallado: ${detail}`,
  errBoardDisabled: (board: string) => `La placa ${board} está desactivada: actívala en Placas de relés`,
  errChannelNotFound: "Ese relé ya no existe en este equipo. Recarga la página.",
  errBoardNotFound: "La placa ya no existe. Recarga la página.",
  errNotHolder: "Reserva el equipo para usar sus relés.",
  errConfirm: "Confirma la acción: este relé corta la alimentación o reinicia el equipo.",
  errSimulatedNotAllowed: "El controlador simulado solo está disponible con RM_RELAY_SIMULATE=1",
  errRelayCountTooHigh: (max: number) => `Este controlador admite como máximo ${max} relés`,
  errRelayCountBelowBound: (channel: number) => `Hay un relé asignado en el canal ${channel}: reduce el número de relés solo hasta ese canal`,
  errConfirmName: "Escribe el nombre exacto de la placa para confirmar",
  errNameTaken: "Ya existe una placa con ese nombre",
  errAddressTaken: "Ya hay una placa registrada en esa dirección y puerto",
  errMacTaken: "Ya hay una placa registrada con esa MAC",

  // Discovery (hints and warnings; Spanish, shown in Descubrimiento)
  hintMicrochip: "OUI Microchip",
  hintOtherIp: (ip: string) => `La placa anuncia otra IP: ${ip}`,
  hintUnreachable:
    "La placa responde por UDP desde otra subred (p. ej. 192.168.0.123). Añade una IP secundaria temporal a la interfaz o configúrala por USB.",
  hintNotProbed: "Fuera de las subredes del servidor: no se ha consultado",
  hintAuthRequired: "La página web pide contraseña: usa el controlador ASCII TCP",
  warnNoTargets: "No hay interfaces de red para buscar placas: revisa la red o RM_RELAY_DISCOVERY_BROADCASTS",
  warnSend: (code: string, target: string) => `${code} en ${target}: ${sendErrorHint(code)}`,
  warnScanTruncated: (max: number) => `El escaneo se limita a ${max} direcciones: se han omitido las demás`,
  warnNoCidrs: "No hay subredes que escanear: indica una red o revisa la configuración",
  warnUdpUnavailable: "Escucha UDP 30303 no disponible",
  warnUdpFlood: "Tráfico UDP 30303 excesivo",
  warnUdpRepliesDropped: (dropped: number, max: number) =>
    `Demasiadas respuestas UDP: se han descartado ${dropped} (se atienden como máximo ${max} por búsqueda)`,
  errScanRunning: "Ya hay un escaneo en curso",
  // Log messages (component "relays"/"discovery")
  logPassiveBound: "Escucha pasiva de placas activa",
  logPassiveBindError: "No se puede escuchar en UDP: el descubrimiento pasivo queda desactivado",
  logPollFailed: "Lectura de placa fallida",
  logBoardOnline: "Placa conectada",
  logBoardOffline: "Placa sin respuesta",
  logToggleVarLearned: "Variable dScript aprendida",
} as const

function sendErrorHint(code: string): string {
  switch (code) {
    case "ENETUNREACH": return "sin ruta"
    case "EACCES": return "difusión no permitida"
    case "EHOSTUNREACH": return "equipo inalcanzable"
    case "EADDRNOTAVAIL": return "dirección no disponible"
    default: return "error de envío"
  }
}
