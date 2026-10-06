// Pure core of useAction (§8.8): what the client does with an ActionResult.
import type { ActionResult } from "@/lib/contracts/common"
import { errorMessage } from "@/lib/i18n/errors"
import { safeNextPath } from "@/lib/safe-next"

export type ActionOutcome<T> =
  | { kind: "ok"; data: T }
  | { kind: "redirect"; to: string }
  | { kind: "field-errors"; fieldErrors: Record<string, string[]>; message: string }
  | { kind: "toast"; message: string }

/** "/login?next=<encoded safe path>", or "/login" when the path is "/" or unsafe (same rule as the proxy). */
export function loginRedirect(currentPath: string): string {
  const next = safeNextPath(currentPath)
  return next === "/" ? "/login" : `/login?next=${encodeURIComponent(next)}`
}

export const PASSWORD_CHANGE_PATH = "/cuenta?cambiar=1"

export function interpretActionResult<T>(r: ActionResult<T>, currentPath: string): ActionOutcome<T> {
  if (r.ok) return { kind: "ok", data: r.data }
  const { code, fieldErrors, details } = r.error
  if (code === "UNAUTHENTICATED") return { kind: "redirect", to: loginRedirect(currentPath) }
  if (code === "PASSWORD_CHANGE_REQUIRED") return { kind: "redirect", to: PASSWORD_CHANGE_PATH }
  const message = r.error.message?.trim() ? r.error.message : errorMessage(code, details)
  if (fieldErrors && Object.keys(fieldErrors).length) return { kind: "field-errors", fieldErrors, message }
  return { kind: "toast", message }
}

/** A server action that threw (server stopped, network down, Next rejected the request). */
export function networkFailure(): { ok: false; error: { code: "INTERNAL"; message: string } } {
  return { ok: false, error: { code: "INTERNAL", message: "No se ha podido contactar con el servidor. Comprueba la conexión y vuelve a intentarlo." } }
}
