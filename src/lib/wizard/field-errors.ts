// Dotted field errors on the client (§7.1): the same keys the server returns (`consoles.2.key`, `_form`).
import type { z } from "zod"

export type FieldErrors = Record<string, string[]>

/** Spanish fallbacks for zod issues without a schema message (shared with the server's defineAction). */
export { spanishIssue } from "@/lib/i18n/zod-issues"

/** zod issues → dotted keys (never just `path[0]`: row indexes matter), `_form` for root issues. */
export function zodFieldErrors(err: z.ZodError, prefix = ""): FieldErrors {
  const fe: FieldErrors = {}
  for (const i of err.issues) {
    const path = i.path.map(String).join(".")
    const key = path ? (prefix ? `${prefix}.${path}` : path) : (prefix || "_form")
    ;(fe[key] ??= []).push(i.message)
  }
  return fe
}

export const hasErrors = (fe: FieldErrors | null | undefined): boolean => !!fe && Object.keys(fe).length > 0

/** Merges several error maps; messages for the same key are concatenated without duplicates. */
export function mergeErrors(...maps: Array<FieldErrors | null | undefined>): FieldErrors {
  const out: FieldErrors = {}
  for (const m of maps) {
    if (!m) continue
    for (const [k, v] of Object.entries(m)) out[k] = [...new Set([...(out[k] ?? []), ...v])]
  }
  return out
}
