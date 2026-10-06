// Spanish fallback text for zod issues (§8.7), shared by the server (defineAction) and the client
// pre-validation, so a message never reaches the UI in zod's English whichever side produced it.

/** The parts of a zod issue that `spanishIssue` reads (structural, so any zod raw issue fits). */
export interface IssueLike { code?: string; minimum?: unknown; maximum?: unknown; origin?: unknown; format?: unknown; input?: unknown }

/**
 * Spanish text for zod issues whose contract schema carries no message (`name.min(1)`, `token.min(8)`, `z.email()`,
 * `currentPassword.min(1)`). Schema-level messages ("Las contraseñas no coinciden", "Mínimo 10 caracteres") always
 * win over this map. The server passes it to every action and route parse; clients pass it to their pre-validation.
 */
export function spanishIssue(issue: IssueLike): string {
  switch (issue.code) {
    case "too_small":
      if (issue.origin === "string") return Number(issue.minimum) <= 1 ? "Obligatorio" : `Mínimo ${String(issue.minimum)} caracteres`
      if (issue.origin === "array" || issue.origin === "set") return Number(issue.minimum) <= 1 ? "Elige al menos uno" : `Elige al menos ${String(issue.minimum)}`
      return `Mínimo ${String(issue.minimum)}`
    case "too_big":
      if (issue.origin === "string") return `Máximo ${String(issue.maximum)} caracteres`
      return `Máximo ${String(issue.maximum)}`
    case "invalid_format":
      return issue.format === "email" ? "Correo electrónico no válido" : "Formato no válido"
    case "invalid_type":
      return issue.input === undefined || issue.input === null ? "Obligatorio" : "Valor no válido"
    default:
      return "Valor no válido"
  }
}

