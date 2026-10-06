"use server"
// Own account (§7.2). Allowed while mustChangePassword is set.
import type { ThemePref } from "@/lib/contracts/enums"
import { ChangeOwnPasswordInputSchema, SetMyThemeInputSchema } from "@/lib/contracts/users"
import { errorMessage } from "@/lib/i18n/errors"
import { defineAction } from "@/server/actions/define-action"
import { hashPassword, verifyPassword } from "@/server/auth/passwords"
import { DomainError } from "@/server/errors"

export const changeOwnPassword = defineAction(
  ChangeOwnPasswordInputSchema,
  { auth: "user", allowMustChangePassword: true },
  async function changeOwnPassword(input, { rt, user, actor, ip }): Promise<null> {
    // Guessing the current password is throttled like a login.
    const key = `#password:${user.username}`
    const t = rt.throttle.begin(ip, key)
    if (t.blocked) throw new DomainError("RATE_LIMITED", errorMessage("RATE_LIMITED", { retryAfterSec: t.retryAfterSec }))
    const row = await rt.prisma.user.findUnique({ where: { id: user.id }, select: { passwordHash: true } })
    if (!row || !(await verifyPassword(input.currentPassword, row.passwordHash))) {
      throw new DomainError("VALIDATION", errorMessage("VALIDATION"), { currentPassword: ["La contraseña actual no es correcta"] })
    }
    rt.throttle.success(ip, key, t.ticket)
    const passwordHash = await hashPassword(input.newPassword)
    await rt.prisma.user.update({
      where: { id: user.id },
      data: { passwordHash, mustChangePassword: false, sessionVersion: { increment: 1 } },
    })
    rt.audit.record({ actor, action: "auth.password.changed", target: { type: "user", id: user.id, name: user.username } })
    // Other open sessions (WS/SSE) of this user are revoked by the live-session sweep.
    rt.bus.publish({ type: "session.revoked", userId: user.id, reason: "password-changed" }, { kind: "user", userId: user.id })
    return null
  },
)

/**
 * The account's colour theme (D39): saved per user, so it is the same on every browser and PC, and the root layout
 * renders it before paint. The user's other tabs and PCs apply it through `account.prefs.changed` (audience: that user).
 * Not audited: a cosmetic preference with no security relevance, which would only add noise to the append-only log.
 * Allowed while a password change is pending (the page it happens on shows the theme menu too).
 */
export const setMyTheme = defineAction(
  SetMyThemeInputSchema,
  { auth: "user", allowMustChangePassword: true },
  async function setMyTheme(input, { rt, user }): Promise<{ theme: ThemePref }> {
    await rt.prisma.user.update({ where: { id: user.id }, data: { theme: input.theme } })
    rt.bus.publish({ type: "account.prefs.changed", userId: user.id, theme: input.theme }, { kind: "user", userId: user.id })
    return { theme: input.theme }
  },
)
