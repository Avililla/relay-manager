import type { AuthUser, DomainDeps, UserActor } from "@/server/runtime/types"

/**
 * What every stateless domain function receives (§4.15). An action's `ActionContext` ({ rt: Runtime, user, actor, ip })
 * is structurally assignable, because `Runtime` is a superset of `DomainDeps`.
 */
export interface DomainContext {
  rt: DomainDeps
  user: AuthUser
  actor: UserActor
}
