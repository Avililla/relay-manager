// Small helpers shared by the W1-C domain services. Stateless.
import type { PrismaClient } from "@/generated/prisma/client"
import type { JsonValue } from "@/lib/contracts/common"
import { errorMessage } from "@/lib/i18n/errors"
import { domainText } from "@/lib/i18n/domain"
import { DomainError } from "@/server/errors"
import type { Logger } from "@/server/log"

export function validationError(fieldErrors: Record<string, string[]>): DomainError {
  return new DomainError("VALIDATION", errorMessage("VALIDATION"), fieldErrors)
}
export function conflictError(fieldErrors: Record<string, string[]>, message?: string): DomainError {
  return new DomainError("CONFLICT", message ?? errorMessage("CONFLICT"), fieldErrors)
}
export function notFound(message?: string): DomainError {
  return new DomainError("NOT_FOUND", message ?? errorMessage("NOT_FOUND"))
}

/** Prefixes every key of a field-error map ("consoles.0.key" → "templateUpdate.consoles.0.key"). */
export function prefixFieldErrors(prefix: string, fe: Record<string, string[]>): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const [k, v] of Object.entries(fe)) out[k === "_form" ? prefix : `${prefix}.${k}`] = v
  return out
}

export async function assertRolesExist(prisma: PrismaClient, roleIds: readonly string[], field = "roleIds"): Promise<void> {
  const unique = [...new Set(roleIds)]
  if (!unique.length) return
  const n = await prisma.role.count({ where: { id: { in: unique } } })
  if (n !== unique.length) throw validationError({ [field]: [domainText.roleMissing] })
}

/** Runs a post-commit side effect (service reload); a failure is logged, never thrown into the action. */
export async function afterCommit(log: Logger, what: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn()
  } catch (err) {
    log.error(`Error tras guardar: ${what}`, { err })
  }
}

/** Shallow diff of scalar fields for audit details: { field: [before, after] } for the fields that changed. */
export function scalarDiff<T extends Record<string, JsonValue>>(before: T, after: T): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {}
  for (const k of Object.keys(after)) {
    const a = before[k] ?? null
    const b = after[k] ?? null
    if (JSON.stringify(a) !== JSON.stringify(b)) out[k] = [a, b]
  }
  return out
}
