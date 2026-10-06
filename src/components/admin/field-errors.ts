// Client-side pre-validation with the same zod schema the action uses (D14), producing the same dotted-key
// field errors as defineAction (§7.1) so FormField/FormErrors render both sources identically.
import type { z } from "zod"
import { spanishIssue, type IssueLike } from "@/lib/i18n/zod-issues"

export type FieldErrors = Record<string, string[]>

export { spanishIssue, type IssueLike }

/** Client pre-validation options: Spanish fallbacks for contract schemas without their own messages. */
export const SPANISH_PARSE = { error: spanishIssue } as const

export function zodFieldErrors(err: z.ZodError): FieldErrors {
  const fe: FieldErrors = {}
  for (const i of err.issues) (fe[i.path.map(String).join(".") || "_form"] ??= []).push(i.message)
  return fe
}

/** Server errors win for a key; local ones fill the rest. Empty lists are dropped. */
export function mergeFieldErrors(...sources: Array<FieldErrors | null | undefined>): FieldErrors {
  const out: FieldErrors = {}
  for (const s of sources) {
    if (!s) continue
    for (const [k, v] of Object.entries(s)) if (v.length && !out[k]) out[k] = v
  }
  return out
}

/** Drops the errors of one field once the user edits it. */
export function withoutField(errors: FieldErrors, key: string): FieldErrors {
  if (!(key in errors)) return errors
  const rest = { ...errors }
  delete rest[key]
  return rest
}
