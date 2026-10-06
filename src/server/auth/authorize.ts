// The ordered `authorize` algorithm of §6.3. Each step is unit-tested (authorize.test.ts).
import crypto from "node:crypto"
import { CredentialsSignin } from "next-auth"
import type { PrismaClient } from "@/generated/prisma/client"
import { CredentialsSchema } from "@/lib/contracts/users"
import type { AuditService, LoginThrottle } from "@/server/runtime/types"
import { DUMMY_HASH, verifyPassword } from "./passwords"

export class RateLimitedError extends CredentialsSignin { code = "rate_limited" }
export class DisabledError extends CredentialsSignin { code = "disabled" }

export interface AuthorizedUser { id: string; name: string; username: string; sv: number }
export interface AuthorizeDeps { prisma: PrismaClient; throttle: LoginThrottle; audit: AuditService }

/** Pseudo-username for invalid input: counts toward the IP window without touching a real (ip, username) pair. */
const INVALID_KEY = "\u0000invalid"

function fail(deps: AuthorizeDeps, ip: string, username: string, reason: "bad-credentials" | "disabled" | "throttled" | "invalid-input", actor?: { id: string; name: string }): void {
  deps.audit.record({
    actor: actor ? { kind: "user", id: actor.id, name: actor.name, ip } : { kind: "user", id: null, name: reason === "invalid-input" ? "(no válido)" : username, ip },
    action: "auth.login.fail",
    outcome: "ok",
    target: { type: "session", name: username },
    detail: { username, reason },
  })
}

export async function authorizeCredentials(raw: unknown, ip: string, deps: AuthorizeDeps): Promise<AuthorizedUser | null> {
  // 2. Validate before anything else.
  const parsed = CredentialsSchema.safeParse(raw)
  if (!parsed.success) {
    const r = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {}
    const tried = String(r.username ?? "").slice(0, 64)
    // A fresh pseudo-username per attempt, so the pair window never saturates and every attempt counts for the IP.
    const t = deps.throttle.begin(ip, `${INVALID_KEY}${crypto.randomUUID()}`)
    if (!t.blocked || deps.throttle.shouldAuditThrottled(ip, INVALID_KEY)) fail(deps, ip, tried, "invalid-input")
    return null
  }
  const { username, password } = parsed.data

  // 3. Throttle; the attempt is recorded as a failure now.
  const t = deps.throttle.begin(ip, username)
  if (t.blocked) {
    if (deps.throttle.shouldAuditThrottled(ip, username)) fail(deps, ip, username, "throttled")
    throw new RateLimitedError()
  }

  // 4. Compare against the user's hash, or a dummy hash when the user does not exist (same timing).
  const user = await deps.prisma.user.findUnique({
    where: { username },
    select: { id: true, username: true, name: true, passwordHash: true, disabled: true, sessionVersion: true },
  })
  const ok = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH)

  // 5. Wrong password → bad-credentials. The disabled state is never revealed before the password is verified.
  if (!user || !ok) {
    fail(deps, ip, username, "bad-credentials")
    return null
  }
  if (user.disabled) {
    fail(deps, ip, username, "disabled", { id: user.id, name: user.username })
    throw new DisabledError()
  }

  // 6. Success.
  deps.throttle.success(ip, username, t.ticket)
  await deps.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } })
  deps.audit.record({
    actor: { kind: "user", id: user.id, name: user.username, ip },
    action: "auth.login.ok",
    target: { type: "session", id: user.id, name: user.username },
  })
  return { id: user.id, name: user.name, username: user.username, sv: user.sessionVersion }
}
