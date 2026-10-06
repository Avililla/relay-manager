import type { ErrorCode, JsonValue } from "@/lib/contracts/common"

export class DomainError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly fieldErrors?: Record<string, string[]>,
    readonly details?: Record<string, JsonValue>,
  ) {
    super(message)
    this.name = "DomainError"
  }
}
export interface DomainErrorLike {
  name: "DomainError"; code: ErrorCode; message: string
  fieldErrors?: Record<string, string[]>; details?: Record<string, JsonValue>
}
/** Structural check: works across the two module graphs (never use instanceof). */
export function isDomainError(e: unknown): e is DomainErrorLike {
  if (typeof e !== "object" || e === null) return false
  const o = e as { name?: unknown; code?: unknown; message?: unknown }
  return o.name === "DomainError" && typeof o.code === "string" && typeof o.message === "string"
}
