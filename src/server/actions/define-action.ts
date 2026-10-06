// Server action wrapper (§7.1). Every mutation is `export const x = defineAction(schema, opts, handler)`.
import crypto from "node:crypto"
import { headers } from "next/headers"
import type { z } from "zod"
import type { ActionError, ActionResult, ErrorCode, JsonValue } from "@/lib/contracts/common"
import type { AuditAction } from "@/lib/contracts/audit"
import { errorMessage } from "@/lib/i18n/errors"
import { getAuthUser } from "@/server/authz"
import { isDomainError } from "@/server/errors"
import { clientIp } from "@/server/request-meta"
import { getRuntime } from "@/server/runtime/registry"
import type { AuthUser, Runtime, UserActor } from "@/server/runtime/types"
import { spanishIssue } from "@/lib/i18n/zod-issues"
import { toFieldErrors } from "./field-errors"

export { toFieldErrors }

export interface ActionContext { rt: Runtime; user: AuthUser; actor: UserActor; ip: string }
export interface PublicActionContext { rt: Runtime; ip: string }
export interface ActionOptions { auth: "user" | "admin"; allowMustChangePassword?: boolean; auditDenied?: AuditAction }

const DENIED_CODES = new Set<ErrorCode>(["FORBIDDEN", "PASSWORD_CHANGE_REQUIRED"])
const HOLDER_CODES = new Set<ErrorCode>(["NOT_HOLDER", "RESERVED_BY_OTHER"])

function fail(code: ErrorCode, message?: string, fieldErrors?: Record<string, string[]>, details?: Record<string, JsonValue>): { ok: false; error: ActionError } {
  const error: ActionError = { code, message: message ?? errorMessage(code, details) }
  if (fieldErrors && Object.keys(fieldErrors).length) error.fieldErrors = fieldErrors
  if (details && Object.keys(details).length) error.details = details
  return { ok: false, error }
}

function prismaCode(e: unknown): string | null {
  if (typeof e !== "object" || e === null) return null
  const c = (e as { code?: unknown }).code
  return typeof c === "string" && /^P\d{4}$/.test(c) ? c : null
}

/** Maps any thrown value to an ActionError (§7.1 error mapping). */
export function mapActionError(e: unknown, log?: (ref: string, err: unknown) => void): { ok: false; error: ActionError } {
  if (isDomainError(e)) return fail(e.code, e.message, e.fieldErrors, e.details)
  const pc = prismaCode(e)
  if (pc === "P2002") {
    const target = (e as { meta?: { target?: unknown } }).meta?.target
    const field = Array.isArray(target) ? String(target[0] ?? "_form") : typeof target === "string" ? target : "_form"
    return fail("CONFLICT", undefined, { [field]: ["Ya existe un elemento con ese valor"] })
  }
  if (pc === "P2025") return fail("NOT_FOUND")
  const ref = crypto.randomBytes(4).toString("hex")
  log?.(ref, e)
  return fail("INTERNAL", `Error interno (ref ${ref})`)
}

function logInternal(rt: Runtime | null): (ref: string, err: unknown) => void {
  return (ref, err) => rt?.log.child("http").error("Error interno en una acción", { ref, err })
}

function operationName(handler: (...args: never[]) => unknown): string {
  return handler.name && handler.name !== "handler" ? handler.name : "action"
}

export function defineAction<S extends z.ZodType, T>(
  schema: S,
  opts: ActionOptions,
  handler: (input: z.infer<S>, ctx: ActionContext) => Promise<T>,
): (input: z.input<S>) => Promise<ActionResult<T>> {
  const operation = operationName(handler)
  return async (input: z.input<S>): Promise<ActionResult<T>> => {
    let rt: Runtime | null = null
    let ctx: ActionContext | null = null
    try {
      rt = getRuntime()
      const ip = clientIp(await headers())
      const user = await getAuthUser()
      if (!user) return fail("UNAUTHENTICATED")
      const actor: UserActor = { kind: "user", id: user.id, name: user.username, ip }
      ctx = { rt, user, actor, ip }
      if (user.mustChangePassword && !opts.allowMustChangePassword) {
        rt.audit.record({ actor, action: "auth.denied", outcome: "denied", detail: { operation, code: "PASSWORD_CHANGE_REQUIRED" } })
        return fail("PASSWORD_CHANGE_REQUIRED")
      }
      if (opts.auth === "admin" && !user.isAdmin) {
        rt.audit.record({ actor, action: "auth.denied", outcome: "denied", detail: { operation, code: "FORBIDDEN" } })
        return fail("FORBIDDEN")
      }
      const parsed = schema.safeParse(input, { error: spanishIssue })
      if (!parsed.success) return fail("VALIDATION", undefined, toFieldErrors(parsed.error))
      return { ok: true, data: await handler(parsed.data as z.infer<S>, ctx) }
    } catch (e) {
      const mapped = mapActionError(e, logInternal(rt))
      if (rt && ctx) {
        const code = mapped.error.code
        if (DENIED_CODES.has(code)) {
          rt.audit.record({ actor: ctx.actor, action: "auth.denied", outcome: "denied", detail: { operation, code } })
        } else if (HOLDER_CODES.has(code) && opts.auditDenied) {
          rt.audit.record({ actor: ctx.actor, action: opts.auditDenied, outcome: "denied", detail: { code } })
        }
      }
      return mapped
    }
  }
}

/** Public action (no session). Used only by completeSetup. */
export function definePublicAction<S extends z.ZodType, T>(
  schema: S,
  handler: (input: z.infer<S>, ctx: PublicActionContext) => Promise<T>,
): (input: z.input<S>) => Promise<ActionResult<T>> {
  return async (input: z.input<S>): Promise<ActionResult<T>> => {
    let rt: Runtime | null = null
    try {
      rt = getRuntime()
      const ip = clientIp(await headers())
      const parsed = schema.safeParse(input, { error: spanishIssue })
      if (!parsed.success) return fail("VALIDATION", undefined, toFieldErrors(parsed.error))
      return { ok: true, data: await handler(parsed.data as z.infer<S>, { rt, ip }) }
    } catch (e) {
      return mapActionError(e, logInternal(rt))
    }
  }
}
