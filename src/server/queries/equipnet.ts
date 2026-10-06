import "server-only"
// Read side of "Red de equipos" (admin): the whole status for Sistema › Red de equipos and the manual instructions.
import type { EquipnetStatusDTO, ManualInstructionsDTO } from "@/lib/contracts/equipnet"
import { errorMessage } from "@/lib/i18n/errors"
import { DomainError } from "@/server/errors"
import { getRuntime } from "@/server/runtime/registry"
import type { AuthUser } from "@/server/runtime/types"

export interface EquipnetPageDTO { status: EquipnetStatusDTO; manual: ManualInstructionsDTO }

export async function getEquipnetPage(user: AuthUser): Promise<EquipnetPageDTO> {
  if (!user.isAdmin) throw new DomainError("FORBIDDEN", errorMessage("FORBIDDEN"))
  const rt = getRuntime()
  return { status: rt.equipnet.status(), manual: rt.equipnet.manualInstructions() }
}

/** The passive card on Banco (admins): network interfaces not configured yet (a link to Sistema › Red de equipos). */
export function getEquipnetOffer(user: AuthUser): EquipnetStatusDTO | null {
  if (!user.isAdmin) return null
  const s = getRuntime().equipnet.status()
  return s.offerSetup ? s : null
}
