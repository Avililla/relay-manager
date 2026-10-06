/** Shared Spanish strings (sentence case, full accents). Area-specific strings live in their own modules. */
export const PRODUCT_NAME = "Relay Manager"
export const DEFAULT_LAB_NAME = "Relay Manager"

export const common = {
  yes: "Sí",
  no: "No",
  cancel: "Cancelar",
  save: "Guardar",
  saving: "Guardando…",
  retry: "Reintentar",
  close: "Cerrar",
  loading: "Cargando…",
  connecting: "Conectando…",
  none: "Ninguno",
  unknown: "Desconocido",
  logout: "Cerrar sesión",
  login: "Entrar",
  username: "Usuario",
  password: "Contraseña",
  name: "Nombre",
  admin: "Administrador",
} as const

/** "<Página> · <labName>" (§8.1). */
export function pageTitle(page: string | null, labName: string): string {
  return page ? `${page} · ${labName}` : labName
}
