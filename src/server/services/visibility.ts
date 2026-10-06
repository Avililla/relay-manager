// Equipment visibility (§4.15). The rule itself lives in the W0 module src/server/access.ts (D41); this only adapts it.
import type { PrismaClient } from "@/generated/prisma/client"
import { visibleEquipmentIdsFor } from "@/server/access"
import type { AuthUser } from "@/server/runtime/types"

type VisibilityUser = Pick<AuthUser, "isAdmin" | "roleIds">

/** Every id for admins; otherwise equipment with no roles or with a role in common. */
export async function visibleEquipmentIds(prisma: PrismaClient, user: VisibilityUser): Promise<string[]> {
  const ids = await visibleEquipmentIdsFor(prisma, user)
  if (ids !== "all") return ids
  return (await prisma.equipment.findMany({ select: { id: true } })).map((r) => r.id)
}

/** Same rule as a set; "all" for admins (no query), so equipment created later is included without a recompute. */
export async function visibleEquipmentSet(prisma: PrismaClient, user: VisibilityUser): Promise<Set<string> | "all"> {
  const ids = await visibleEquipmentIdsFor(prisma, user)
  return ids === "all" ? "all" : new Set(ids)
}
