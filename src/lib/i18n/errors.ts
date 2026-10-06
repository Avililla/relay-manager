import type { ErrorCode, JsonValue } from "@/lib/contracts/common"

const str = (v: JsonValue | undefined): string | null => (typeof v === "string" && v.trim() ? v : typeof v === "number" ? String(v) : null)

/** Default Spanish message for an error code; says what happened and what to do (§8.7). */
export function errorMessage(code: ErrorCode, details?: Record<string, JsonValue>): string {
  switch (code) {
    case "UNAUTHENTICATED": return "Tu sesión ha caducado. Vuelve a iniciar sesión."
    case "FORBIDDEN": return "No tienes permiso para hacer esto."
    case "PASSWORD_CHANGE_REQUIRED": return "Debes cambiar tu contraseña antes de continuar."
    case "NOT_FOUND": return "No se ha encontrado: puede que otra persona lo haya borrado. Recarga la página."
    case "VALIDATION": return "Revisa los campos marcados."
    case "CONFLICT": return "Ya existe un elemento con esos datos. Usa otro nombre."
    case "RESERVED_BY_OTHER": {
      const who = str(details?.holderName)
      return who ? `Reservado por ${who}. Espera a que lo libere o pide a un administrador que fuerce la liberación.`
        : "Otro usuario tiene la reserva de este equipo."
    }
    case "NOT_HOLDER": return "Reserva el equipo para hacer esto."
    case "NOT_RESERVED": return "El equipo no está reservado."
    case "LAST_ADMIN": return "No se puede: es el último administrador activo. Crea o activa otro administrador antes."
    case "DEVICE_NOT_FOUND": return "El puerto serie ya no está conectado. Vuelve a buscar adaptadores."
    case "DEVICE_BUSY": return "El puerto está en uso por otro programa. Ciérralo e inténtalo de nuevo."
    case "DEVICE_ALREADY_BOUND": return "Ese puerto ya está asignado a otra consola."
    case "PORT_NOT_OPEN": return "El puerto de la consola no está abierto."
    case "CONFIRMATION_REQUIRED": return "Esta acción necesita confirmación."
    case "DRIVER_ERROR": {
      const d = str(details?.detail)
      return d ? `La placa de relés ha fallado: ${d}` : "La placa de relés no ha respondido como se esperaba. Comprueba la conexión."
    }
    case "DISABLED_BY_POLICY": return "Esta función está desactivada en la configuración del servidor."
    case "RATE_LIMITED": {
      const s = str(details?.retryAfterSec)
      return s ? `Demasiados intentos. Espera ${s} s y vuelve a intentarlo.` : "Demasiados intentos. Espera unos minutos y vuelve a intentarlo."
    }
    case "SETUP_DONE": return "La configuración inicial ya está completada. Inicia sesión."
    case "SETUP_TOKEN_INVALID": return "El código de configuración no es correcto. Consúltalo en el registro del servidor o con «relay-manager setup-token»."
    case "SERVICE_UNAVAILABLE": return "Esta función no está disponible todavía."
    case "INTERNAL": return "Error interno. Inténtalo de nuevo y, si se repite, avisa al administrador."
  }
}
