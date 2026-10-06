// User domain service (§4.15, W1-C). Only a password change or reset, disable and delete bump sessionVersion (D28);
// role and admin changes publish viewer.changed so that live sockets refresh (§6.2).
import type { z } from "zod"
import type { Prisma } from "@/generated/prisma/client"
import type { JsonValue } from "@/lib/contracts/common"
import type {
  CreateUserInputSchema, ResetUserPasswordInputSchema, SetUserDisabledInputSchema, UpdateUserInputSchema, UserRefInputSchema,
} from "@/lib/contracts/users"
import { domainText } from "@/lib/i18n/domain"
import { errorMessage } from "@/lib/i18n/errors"
import { hashPassword } from "@/server/auth/passwords"
import { DomainError } from "@/server/errors"
import { assertRolesExist, conflictError, notFound, scalarDiff, validationError } from "./common"
import type { DomainContext } from "./context"

type Tx = Prisma.TransactionClient

const lastAdmin = () => new DomainError("LAST_ADMIN", errorMessage("LAST_ADMIN"))

/** Inside the write transaction: the change must leave at least one enabled admin (race-safe last-admin rule). */
async function assertAdminsRemain(tx: Tx): Promise<void> {
  if (await tx.user.count({ where: { isAdmin: true, disabled: false } }) === 0) throw lastAdmin()
}

async function loadUser(ctx: DomainContext, id: string) {
  const u = await ctx.rt.prisma.user.findUnique({ where: { id }, include: { roles: { select: { id: true, name: true } } } })
  if (!u) throw notFound(domainText.userNotFound)
  return u
}

export async function createUser(input: z.infer<typeof CreateUserInputSchema>, ctx: DomainContext): Promise<{ id: string }> {
  const { rt, actor } = ctx
  if (await rt.prisma.user.findUnique({ where: { username: input.username }, select: { id: true } })) {
    throw conflictError({ username: [domainText.usernameTaken] })
  }
  await assertRolesExist(rt.prisma, input.roleIds)
  const u = await rt.prisma.user.create({
    data: {
      username: input.username, name: input.name, email: input.email, passwordHash: await hashPassword(input.password),
      isAdmin: input.isAdmin, mustChangePassword: input.mustChangePassword,
      roles: { connect: [...new Set(input.roleIds)].map((id) => ({ id })) },
    },
    include: { roles: { select: { name: true } } },
  })
  rt.audit.record({
    actor, action: "user.create", target: { type: "user", id: u.id, name: u.username },
    detail: { name: u.name, isAdmin: u.isAdmin, mustChangePassword: u.mustChangePassword, roles: u.roles.map((r) => r.name) },
  })
  return { id: u.id }
}

export async function updateUser(input: z.infer<typeof UpdateUserInputSchema>, ctx: DomainContext): Promise<{ id: string }> {
  const { rt, actor } = ctx
  const before = await loadUser(ctx, input.userId)
  await assertRolesExist(rt.prisma, input.roleIds)
  const roleIds = [...new Set(input.roleIds)]
  const after = await rt.prisma.$transaction(async (tx) => {
    const u = await tx.user.update({
      where: { id: before.id },
      data: { name: input.name, email: input.email, isAdmin: input.isAdmin, roles: { set: roleIds.map((id) => ({ id })) } },
      include: { roles: { select: { id: true, name: true } } },
    })
    if (before.isAdmin && !before.disabled && !input.isAdmin) await assertAdminsRemain(tx)
    return u
  })
  const changed = scalarDiff(
    { name: before.name, email: before.email, isAdmin: before.isAdmin },
    { name: after.name, email: after.email, isAdmin: after.isAdmin },
  )
  const beforeRoles = before.roles.map((r) => r.id).sort()
  const afterRoles = after.roles.map((r) => r.id).sort()
  const rolesChanged = JSON.stringify(beforeRoles) !== JSON.stringify(afterRoles)
  const detail: Record<string, JsonValue> = { changed }
  if (rolesChanged) detail.roles = { before: before.roles.map((r) => r.name).sort(), after: after.roles.map((r) => r.name).sort() }
  if (rolesChanged || before.isAdmin !== after.isAdmin) {
    rt.bus.publish({ type: "viewer.changed", userId: after.id }, { kind: "user", userId: after.id })
  }
  rt.audit.record({ actor, action: "user.update", target: { type: "user", id: after.id, name: after.username }, detail })
  return { id: after.id }
}

/** Self-disable/delete: the specific reason is the message (shown as-is), not the generic "Revisa los campos marcados.". */
function selfError(text: string): DomainError {
  return new DomainError("VALIDATION", text, { _form: [text] })
}

export async function setUserDisabled(input: z.infer<typeof SetUserDisabledInputSchema>, ctx: DomainContext): Promise<null> {
  const { rt, actor, user } = ctx
  if (input.disabled && input.userId === user.id) throw selfError(domainText.cannotDisableSelf)
  const target = await loadUser(ctx, input.userId)
  if (target.disabled === input.disabled) return null
  if (input.disabled) {
    await rt.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: target.id }, data: { disabled: true, sessionVersion: { increment: 1 } } })
      if (target.isAdmin) await assertAdminsRemain(tx)
    })
    await rt.reservations.releaseAllForUser(target.id, "user-disabled")
    rt.bus.publish({ type: "session.revoked", userId: target.id, reason: "disabled" }, { kind: "user", userId: target.id })
    rt.audit.record({ actor, action: "user.disable", target: { type: "user", id: target.id, name: target.username } })
  } else {
    await rt.prisma.user.update({ where: { id: target.id }, data: { disabled: false } })
    rt.audit.record({ actor, action: "user.enable", target: { type: "user", id: target.id, name: target.username } })
  }
  return null
}

export async function resetUserPassword(input: z.infer<typeof ResetUserPasswordInputSchema>, ctx: DomainContext): Promise<null> {
  const { rt, actor } = ctx
  const target = await loadUser(ctx, input.userId)
  if (input.password.toLowerCase() === target.username) {
    throw validationError({ password: ["La contraseña no puede ser el nombre de usuario"] })
  }
  await rt.prisma.user.update({
    where: { id: target.id },
    data: { passwordHash: await hashPassword(input.password), mustChangePassword: input.mustChangePassword, sessionVersion: { increment: 1 } },
  })
  rt.bus.publish({ type: "session.revoked", userId: target.id, reason: "password-changed" }, { kind: "user", userId: target.id })
  rt.audit.record({ actor, action: "user.password.reset", target: { type: "user", id: target.id, name: target.username }, detail: { mustChangePassword: input.mustChangePassword } })
  return null
}

export async function deleteUser(input: z.infer<typeof UserRefInputSchema>, ctx: DomainContext): Promise<null> {
  const { rt, actor, user } = ctx
  if (input.userId === user.id) throw selfError(domainText.cannotDeleteSelf)
  const target = await loadUser(ctx, input.userId)
  const enabledAdmin = target.isAdmin && !target.disabled
  if (enabledAdmin && await rt.prisma.user.count({ where: { isAdmin: true, disabled: false } }) <= 1) throw lastAdmin()
  // Release first: deleting the user would only null reservedById (onDelete: SetNull) without any event.
  await rt.reservations.releaseAllForUser(target.id, "user-deleted")
  await rt.prisma.$transaction(async (tx) => {
    await tx.user.delete({ where: { id: target.id } })
    if (enabledAdmin) await assertAdminsRemain(tx)
  })
  rt.bus.publish({ type: "session.revoked", userId: target.id, reason: "deleted" }, { kind: "user", userId: target.id })
  rt.audit.record({ actor, action: "user.delete", target: { type: "user", id: target.id, name: target.username }, detail: { name: target.name, isAdmin: target.isAdmin } })
  return null
}
