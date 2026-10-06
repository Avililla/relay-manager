// NextAuth jwt/session callbacks (§6.2): the user is re-read from the DB on every call.
import type { Session } from "next-auth"
import type { JWT } from "next-auth/jwt"
import type { PrismaClient } from "@/generated/prisma/client"

export const ABS_CAP_MIN_MS = 72 * 3600_000

/** Absolute session cap: max(72 h, maxAge). */
export function absoluteCapMs(maxAgeSec: number): number {
  return Math.max(ABS_CAP_MIN_MS, maxAgeSec * 1000)
}

export interface CallbackDeps { prisma: PrismaClient; maxAgeSec: number; now?: () => number }

export async function refreshJwt(token: JWT, user: { id?: string; sv?: number } | undefined, deps: CallbackDeps): Promise<JWT | null> {
  const now = deps.now ?? Date.now
  if (user?.id) {
    token.id = user.id
    token.sv = typeof user.sv === "number" ? user.sv : 1
    token.loginAt = now()
  }
  const id = token.id
  if (typeof id !== "string" || typeof token.sv !== "number" || typeof token.loginAt !== "number") return null
  const row = await deps.prisma.user.findUnique({
    where: { id },
    select: { username: true, name: true, isAdmin: true, disabled: true, mustChangePassword: true, sessionVersion: true, roles: { select: { id: true } } },
  })
  if (!row || row.disabled) return null
  if (row.sessionVersion !== token.sv) return null
  if (now() - token.loginAt > absoluteCapMs(deps.maxAgeSec)) return null
  token.username = row.username
  token.name = row.name
  token.isAdmin = row.isAdmin
  token.roleIds = row.roles.map((r) => r.id)
  token.mustChangePassword = row.mustChangePassword
  return token
}

export function sessionFromToken(session: Session | { user?: unknown; expires: string }, token: JWT): Session {
  return {
    ...(session as Session),
    user: {
      id: token.id ?? "",
      username: token.username ?? "",
      name: token.name ?? "",
      email: null,
      image: null,
      isAdmin: token.isAdmin ?? false,
      roleIds: token.roleIds ?? [],
      mustChangePassword: token.mustChangePassword ?? false,
    },
  }
}
