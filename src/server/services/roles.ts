// Role domain service (§4.15, W1-C). Roles restrict equipment visibility; every change notifies the affected viewers
// (viewer.changed → live-session refresh) and the affected equipment (equipment.changed → visible-set recompute).
import type { z } from "zod"
import type { PrismaClient } from "@/generated/prisma/client"
import type { JsonValue } from "@/lib/contracts/common"
import type { RoleInputSchema, RoleRefInputSchema, UpdateRoleInputSchema } from "@/lib/contracts/users"
import { domainText } from "@/lib/i18n/domain"
import type { DomainDeps } from "@/server/runtime/types"
import { conflictError, notFound, scalarDiff, validationError } from "./common"
import type { DomainContext } from "./context"
import { sameName } from "./dto"

type RoleInput = z.infer<typeof RoleInputSchema>

async function assertNameFree(prisma: PrismaClient, name: string, exceptId: string | null): Promise<void> {
  const rows = await prisma.role.findMany({ select: { id: true, name: true } })
  if (rows.some((r) => r.id !== exceptId && sameName(r.name, name))) throw conflictError({ name: [domainText.roleNameTaken] })
}

async function assertMembersExist(prisma: PrismaClient, input: Pick<RoleInput, "userIds" | "equipmentIds">): Promise<void> {
  const users = [...new Set(input.userIds)]
  const equipment = [...new Set(input.equipmentIds)]
  const errors: Record<string, string[]> = {}
  if (users.length && await prisma.user.count({ where: { id: { in: users } } }) !== users.length) errors.userIds = [domainText.userMissing]
  if (equipment.length && await prisma.equipment.count({ where: { id: { in: equipment } } }) !== equipment.length) errors.equipmentIds = [domainText.equipmentMissing]
  if (Object.keys(errors).length) throw validationError(errors)
}

function notify(rt: Pick<DomainDeps, "bus">, userIds: Iterable<string>, equipmentIds: Iterable<string>): void {
  for (const userId of new Set(userIds)) rt.bus.publish({ type: "viewer.changed", userId }, { kind: "user", userId })
  for (const equipmentId of new Set(equipmentIds)) rt.bus.publish({ type: "equipment.changed", equipmentId, change: "updated" }, { kind: "all" })
}

const symDiff = (a: ReadonlySet<string>, b: ReadonlySet<string>): string[] => [...[...a].filter((x) => !b.has(x)), ...[...b].filter((x) => !a.has(x))]

export async function createRole(input: RoleInput, ctx: DomainContext): Promise<{ id: string }> {
  const { rt, actor } = ctx
  await assertNameFree(rt.prisma, input.name, null)
  await assertMembersExist(rt.prisma, input)
  const role = await rt.prisma.role.create({
    data: {
      name: input.name, description: input.description,
      users: { connect: [...new Set(input.userIds)].map((id) => ({ id })) },
      equipments: { connect: [...new Set(input.equipmentIds)].map((id) => ({ id })) },
    },
    include: { users: { select: { username: true } }, equipments: { select: { name: true } } },
  })
  notify(rt, input.userIds, input.equipmentIds)
  rt.audit.record({
    actor, action: "role.create", target: { type: "role", id: role.id, name: role.name },
    detail: { users: role.users.map((u) => u.username).sort(), equipment: role.equipments.map((e) => e.name).sort() },
  })
  return { id: role.id }
}

export async function updateRole(input: z.infer<typeof UpdateRoleInputSchema>, ctx: DomainContext): Promise<{ id: string }> {
  const { rt, actor } = ctx
  const before = await rt.prisma.role.findUnique({
    where: { id: input.roleId },
    include: { users: { select: { id: true, username: true } }, equipments: { select: { id: true, name: true } } },
  })
  if (!before) throw notFound(domainText.roleNotFound)
  await assertNameFree(rt.prisma, input.name, before.id)
  await assertMembersExist(rt.prisma, input)
  const after = await rt.prisma.role.update({
    where: { id: before.id },
    data: {
      name: input.name, description: input.description,
      users: { set: [...new Set(input.userIds)].map((id) => ({ id })) },
      equipments: { set: [...new Set(input.equipmentIds)].map((id) => ({ id })) },
    },
    include: { users: { select: { id: true, username: true } }, equipments: { select: { id: true, name: true } } },
  })
  const usersBefore = new Set(before.users.map((u) => u.id))
  const usersAfter = new Set(after.users.map((u) => u.id))
  const eqBefore = new Set(before.equipments.map((e) => e.id))
  const eqAfter = new Set(after.equipments.map((e) => e.id))
  const eqChanged = symDiff(eqBefore, eqAfter)
  const usersChanged = symDiff(usersBefore, usersAfter)
  notify(rt, [...usersChanged, ...(eqChanged.length ? [...usersAfter] : [])], eqChanged)
  const detail: Record<string, JsonValue> = {
    changed: scalarDiff({ name: before.name, description: before.description }, { name: after.name, description: after.description }),
  }
  if (usersChanged.length) detail.users = { before: before.users.map((u) => u.username).sort(), after: after.users.map((u) => u.username).sort() }
  if (eqChanged.length) detail.equipment = { before: before.equipments.map((e) => e.name).sort(), after: after.equipments.map((e) => e.name).sort() }
  rt.audit.record({ actor, action: "role.update", target: { type: "role", id: after.id, name: after.name }, detail })
  return { id: after.id }
}

export async function deleteRole(input: z.infer<typeof RoleRefInputSchema>, ctx: DomainContext): Promise<null> {
  const { rt, actor } = ctx
  const role = await rt.prisma.role.findUnique({
    where: { id: input.roleId },
    include: { users: { select: { id: true } }, equipments: { select: { id: true } } },
  })
  if (!role) throw notFound(domainText.roleNotFound)
  await rt.prisma.role.delete({ where: { id: role.id } })
  notify(rt, role.users.map((u) => u.id), role.equipments.map((e) => e.id))
  rt.audit.record({
    actor, action: "role.delete", target: { type: "role", id: role.id, name: role.name },
    detail: { users: role.users.length, equipment: role.equipments.length },
  })
  return null
}
