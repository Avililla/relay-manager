"use server"
// First-run setup (§6.6). The only public action.
import { SetupInputSchema } from "@/lib/contracts/users"
import { errorMessage } from "@/lib/i18n/errors"
import { definePublicAction } from "@/server/actions/define-action"
import { hashPassword } from "@/server/auth/passwords"
import { deleteSetupToken, isSetupPending, readSetupToken, verifySetupToken } from "@/server/auth/setup-token"
import { DomainError } from "@/server/errors"
import type { Runtime } from "@/server/runtime/types"

/** At most one auth.setup.fail per IP per minute (shared key for both reasons). */
function auditFail(rt: Runtime, ip: string, reason: "bad-token" | "throttled"): void {
  if (!rt.throttle.shouldAuditThrottled(ip, "#setup")) return
  rt.audit.record({ actor: { kind: "user", id: null, name: "(configuración inicial)", ip }, action: "auth.setup.fail", outcome: "ok", target: { type: "session" }, detail: { reason } })
}

export const completeSetup = definePublicAction(SetupInputSchema, async function completeSetup(input, { rt, ip }) {
  if (!rt.throttle.setupAttempt(ip)) {
    auditFail(rt, ip, "throttled")
    throw new DomainError("RATE_LIMITED", errorMessage("RATE_LIMITED"))
  }
  const token = readSetupToken(rt.config.dataDir)
  if (!token) {
    if (!(await isSetupPending(rt.prisma))) throw new DomainError("SETUP_DONE", errorMessage("SETUP_DONE"))
    auditFail(rt, ip, "bad-token")
    throw new DomainError("SETUP_TOKEN_INVALID", errorMessage("SETUP_TOKEN_INVALID"))
  }
  if (!verifySetupToken(input.token, token)) {
    auditFail(rt, ip, "bad-token")
    throw new DomainError("SETUP_TOKEN_INVALID", errorMessage("SETUP_TOKEN_INVALID"), { token: ["El código no es correcto"] })
  }

  const passwordHash = await hashPassword(input.password)
  const user = await rt.prisma.$transaction(async (tx) => {
    // Claim setup first, atomically: two racing submissions give one success and one SETUP_DONE.
    const claim = await tx.settings.updateMany({ where: { id: "global", setupCompletedAt: null }, data: { setupCompletedAt: new Date() } })
    if (claim.count !== 1) throw new DomainError("SETUP_DONE", errorMessage("SETUP_DONE"))
    return tx.user.create({
      data: { username: input.username, name: input.name, passwordHash, isAdmin: true, mustChangePassword: false },
      select: { id: true, username: true },
    })
  })

  deleteSetupToken(rt.config.dataDir)
  rt.state.setupPending = false
  rt.audit.record({
    actor: { kind: "user", id: user.id, name: user.username, ip },
    action: "auth.setup.completed",
    target: { type: "user", id: user.id, name: user.username },
  })
  rt.log.child("auth").info("Configuración inicial completada", { usuario: user.username })
  return { username: user.username }
})
