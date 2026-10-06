import type { z } from "zod"

/**
 * Field errors keyed by the FULL dotted path (`consoles.2.binding`); `_form` holds root-level errors (§7.1).
 * `z.flattenError` keys only by path[0] and loses row indexes.
 */
export function toFieldErrors(err: z.ZodError): Record<string, string[]> {
  const fe: Record<string, string[]> = {}
  for (const i of err.issues) (fe[i.path.map(String).join(".") || "_form"] ??= []).push(i.message)
  return fe
}
