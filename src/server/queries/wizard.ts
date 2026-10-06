import "server-only"
// "Nuevo equipo" wizard data (§7.4, §8.9, W1-C). Admin only.
import type { WizardDataDTO } from "@/lib/contracts/equipment"
import { SERIAL_HINT_CHECKS, type HealthCheckDTO } from "@/lib/contracts/system"
import { errorMessage } from "@/lib/i18n/errors"
import { DomainError } from "@/server/errors"
import { getRuntime } from "@/server/runtime/registry"
import type { AuthUser, Runtime } from "@/server/runtime/types"
import { listBoardChoices } from "@/server/services/board-choices"
import { listTemplates } from "./templates"
import { accessEditContext } from "./accesses"

async function serialHints(rt: Runtime): Promise<HealthCheckDTO[]> {
  try {
    return await rt.ops.health.run({ only: SERIAL_HINT_CHECKS })
  } catch (err) {
    rt.log.child("serial").warn("No se pudieron obtener las comprobaciones de puertos serie", { error: String(err) })
    return []
  }
}

export async function getWizardData(user: AuthUser): Promise<WizardDataDTO> {
  if (!user.isAdmin) throw new DomainError("FORBIDDEN", errorMessage("FORBIDDEN"))
  const rt = getRuntime()
  const [templates, roles, boards, names, hints] = await Promise.all([
    listTemplates(),
    rt.prisma.role.findMany({ select: { id: true, name: true } }),
    listBoardChoices(rt),
    rt.prisma.equipment.findMany({ select: { name: true } }),
    serialHints(rt),
  ])
  return {
    templates: templates.filter((x) => !x.retired),
    roles: roles.sort((a, b) => a.name.localeCompare(b.name, "es")),
    boards,
    serial: rt.serial.discovery.toDTO(),
    serialHints: hints,
    existingNames: names.map((n) => n.name),
    hideJtag: rt.config.serial.hideJtag,
    accessContext: await accessEditContext(rt, null),
  }
}
