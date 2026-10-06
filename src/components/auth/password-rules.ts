// Live password rules shown under every "new password" field (§8.9 Setup, Usuarios, Mi cuenta).
// They mirror PasswordSchema (min 10 chars, max 72 bytes) and the "not the username" refinements of the contracts,
// so the checklist ticks exactly when the server would accept the value.
import { passwordRules as t } from "@/lib/i18n/admin"

export type PasswordRuleId = "min" | "max" | "user"
export interface PasswordRule { id: PasswordRuleId; label: string; ok: boolean }

export const PASSWORD_MIN_CHARS = 10
export const PASSWORD_MAX_BYTES = 72

/** UTF-8 length: bcrypt truncates at 72 bytes, so "ñ" and emoji count double or more. */
export function passwordBytes(password: string): number {
  return new TextEncoder().encode(password).length
}

/**
 * The three rules, in display order. An empty password meets none of them (nothing to tick yet); the username
 * rule compares case-insensitively against the trimmed username, like the contracts' refinements.
 */
export function checkPassword(password: string, username = ""): { rules: PasswordRule[]; ok: boolean } {
  const empty = password.length === 0
  const user = username.trim().toLowerCase()
  const rules: PasswordRule[] = [
    { id: "min", label: t.minLength, ok: password.length >= PASSWORD_MIN_CHARS },
    { id: "max", label: t.maxBytes, ok: !empty && passwordBytes(password) <= PASSWORD_MAX_BYTES },
    { id: "user", label: t.notUsername, ok: !empty && (user === "" || password.toLowerCase() !== user) },
  ]
  return { rules, ok: rules.every((r) => r.ok) }
}

/** Confirmation state: null while the confirmation is still empty (no error yet). */
export function confirmationMatches(password: string, confirm: string): boolean | null {
  if (confirm.length === 0) return null
  return password === confirm
}

/** Contract messages (PasswordSchema and the "not the username" refinements) that the rules list already shows. */
const RULE_MESSAGES = new Set(["Mínimo 10 caracteres", "Máximo 72 bytes", "La contraseña no puede ser el nombre de usuario"])

/** Field errors for a password input minus the ones the rules list shows (no duplicate messages). */
export function withoutRuleMessages(messages: readonly string[]): string[] {
  return messages.filter((m) => !RULE_MESSAGES.has(m))
}
