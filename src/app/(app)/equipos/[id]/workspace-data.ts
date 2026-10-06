// Per-request loader shared by the workspace layout, its pages and their metadata (React `cache` dedupes it
// within one request, so the visibility check and the query run once).
import { cache } from "react"
import { redirect } from "next/navigation"
import { IdSchema } from "@/lib/contracts/common"
import type { EquipmentWorkspaceDTO } from "@/lib/contracts/equipment"
import { getAuthUser } from "@/server/authz"
import { getEquipmentWorkspace } from "@/server/queries/equipment"
import type { AuthUser } from "@/server/runtime/types"

export const loadWorkspace = cache(async (id: string): Promise<{ user: AuthUser; data: EquipmentWorkspaceDTO | null }> => {
  const user = await getAuthUser()
  if (!user) redirect("/login")
  if (!IdSchema.safeParse(id).success) return { user, data: null }
  return { user, data: await getEquipmentWorkspace(user, id) }
})
