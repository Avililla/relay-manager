import "server-only"
// Graph B authorisation helpers (§6.8). The user is always read fresh from the DB.
import { auth } from "@/server/auth"
import { DomainError } from "@/server/errors"
import { errorMessage } from "@/lib/i18n/errors"
import { getRuntime } from "@/server/runtime/registry"
import type { AuthUser } from "@/server/runtime/types"

export async function getAuthUser(): Promise<AuthUser | null> {
  const session = await auth()
  const id = session?.user?.id
  if (!id) return null
  const u = await getRuntime().prisma.user.findUnique({
    where: { id },
    select: { id: true, username: true, name: true, isAdmin: true, disabled: true, mustChangePassword: true, sessionVersion: true, roles: { select: { id: true } } },
  })
  if (!u || u.disabled) return null
  return {
    id: u.id, username: u.username, name: u.name, isAdmin: u.isAdmin, roleIds: u.roles.map((r) => r.id),
    mustChangePassword: u.mustChangePassword, sessionVersion: u.sessionVersion,
  }
}

/** Throws UNAUTHENTICATED or PASSWORD_CHANGE_REQUIRED (unless allowed). */
export async function requireUser(opts: { allowMustChangePassword?: boolean } = {}): Promise<AuthUser> {
  const u = await getAuthUser()
  if (!u) throw new DomainError("UNAUTHENTICATED", errorMessage("UNAUTHENTICATED"))
  if (u.mustChangePassword && !opts.allowMustChangePassword) {
    throw new DomainError("PASSWORD_CHANGE_REQUIRED", errorMessage("PASSWORD_CHANGE_REQUIRED"))
  }
  return u
}

/** Throws UNAUTHENTICATED, PASSWORD_CHANGE_REQUIRED or FORBIDDEN. */
export async function requireAdmin(): Promise<AuthUser> {
  const u = await requireUser()
  if (!u.isAdmin) throw new DomainError("FORBIDDEN", errorMessage("FORBIDDEN"))
  return u
}
