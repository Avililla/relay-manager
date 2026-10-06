import { z } from "zod"

export const IdSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9]+$/, "Identificador no válido")
export type Id = z.infer<typeof IdSchema>

export const ERROR_CODES = [
  "UNAUTHENTICATED", "FORBIDDEN", "PASSWORD_CHANGE_REQUIRED", "NOT_FOUND", "VALIDATION", "CONFLICT",
  "RESERVED_BY_OTHER", "NOT_HOLDER", "NOT_RESERVED", "LAST_ADMIN",
  "DEVICE_NOT_FOUND", "DEVICE_BUSY", "DEVICE_ALREADY_BOUND", "PORT_NOT_OPEN",
  "CONFIRMATION_REQUIRED", "DRIVER_ERROR", "DISABLED_BY_POLICY",
  "RATE_LIMITED", "SETUP_DONE", "SETUP_TOKEN_INVALID", "SERVICE_UNAVAILABLE", "INTERNAL",
] as const
export const ErrorCodeSchema = z.enum(ERROR_CODES)
export type ErrorCode = z.infer<typeof ErrorCodeSchema>

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

export interface ActionError {
  code: ErrorCode
  message: string
  fieldErrors?: Record<string, string[]>
  details?: Record<string, JsonValue>
}
export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: ActionError }

/** ISO-8601 UTC with milliseconds, e.g. "2026-09-23T10:00:00.000Z". */
export type IsoDate = string
export const IsoDateSchema = z.iso.datetime()

export interface Page<T> { items: T[]; nextCursor: string | null }

export const EmptyInputSchema = z.strictObject({})
export const LabelSchema = z.string().trim().min(1, "Obligatorio").max(40)
export const KeySchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,23}$/, "Usa mayúsculas, números y _ (p. ej. UART0)")
export const RegexStringSchema = z.string().max(200).refine((v) => {
  try { new RegExp(v, "i"); return true } catch { return false }
}, "Expresión regular no válida")
