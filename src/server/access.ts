// Equipment access check shared by Graph A and Graph B (D41). Stateless; never import "server-only" here.
import type { PrismaClient } from "@/generated/prisma/client"
import type { AuthUser } from "@/server/runtime/types"
import { canSeeEquipment } from "@/server/authz-rules"

export interface EquipmentRef { id: string; name: string }
type AccessUser = Pick<AuthUser, "isAdmin" | "roleIds">

/** null = missing or not visible (→ NOT_FOUND / 404 / 4004). */
export async function equipmentForUser(prisma: PrismaClient, user: AccessUser, equipmentId: string): Promise<EquipmentRef | null> {
  const eq = await prisma.equipment.findUnique({
    where: { id: equipmentId },
    select: { id: true, name: true, roles: { select: { id: true } } },
  })
  if (!eq || !canSeeEquipment(user, eq.roles.map((r) => r.id))) return null
  return { id: eq.id, name: eq.name }
}

export async function consoleForUser(prisma: PrismaClient, user: AccessUser, consoleId: string):
  Promise<(EquipmentRef & { consoleId: string; key: string; label: string }) | null> {
  const c = await prisma.serialConsole.findUnique({
    where: { id: consoleId },
    select: { id: true, key: true, label: true, equipment: { select: { id: true, name: true, roles: { select: { id: true } } } } },
  })
  if (!c || !canSeeEquipment(user, c.equipment.roles.map((r) => r.id))) return null
  return { id: c.equipment.id, name: c.equipment.name, consoleId: c.id, key: c.key, label: c.label }
}

export async function visibleEquipmentIdsFor(prisma: PrismaClient, user: AccessUser): Promise<string[] | "all"> {
  if (user.isAdmin) return "all"
  const rows = await prisma.equipment.findMany({
    where: user.roleIds.length
      ? { OR: [{ roles: { none: {} } }, { roles: { some: { id: { in: [...user.roleIds] } } } }] }
      : { roles: { none: {} } },
    select: { id: true },
  })
  return rows.map((r) => r.id)
}
