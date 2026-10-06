import "server-only"
// Read side of "Accesos" and "Cables" (admin pages and the editors' context).
import type { AccessEditContextDTO, AccessPortRowDTO, AccessSystemDTO, CablesPageDTO } from "@/lib/contracts/accesses"
import { errorMessage } from "@/lib/i18n/errors"
import { DomainError } from "@/server/errors"
import { getRuntime } from "@/server/runtime/registry"
import type { AuthUser, Runtime } from "@/server/runtime/types"
import { toAccessDTO } from "@/server/services/dto"

/** What the wizard, the equipment settings and the template editor need to edit accesses. */
export async function accessEditContext(rt: Runtime, equipmentId: string | null): Promise<AccessEditContextDTO> {
  const others = await rt.prisma.equipmentAccess.findMany({
    where: equipmentId ? { equipmentId: { not: equipmentId } } : {}, select: { port: true },
  })
  return {
    settings: rt.accesses.settings(),
    usedPorts: others.map((o) => o.port).sort((a, b) => a - b),
    jtag: rt.accesses.jtag(),
    labels: rt.accesses.labels(),
    hwServer: rt.accesses.hwServer(),
    network: rt.equipnet.editContext(equipmentId),
  }
}

function requireAdmin(user: AuthUser): void {
  if (!user.isAdmin) throw new DomainError("FORBIDDEN", errorMessage("FORBIDDEN"))
}

/** Sistema > Accesos: the port map of the whole bench, hw_server, JTAG cables and labels. */
export async function getAccessSystem(user: AuthUser): Promise<AccessSystemDTO> {
  requireAdmin(user)
  const rt = getRuntime()
  const rows = await rt.prisma.equipmentAccess.findMany({
    include: { equipment: { select: { name: true } }, console: { select: { key: true } } },
    orderBy: { port: "asc" },
  })
  const ports: AccessPortRowDTO[] = rows.map((a) => {
    const dto = toAccessDTO(a, rt.accesses.runtime(a.id), (s) => rt.accesses.cableName(s))
    return {
      port: a.port, equipmentId: a.equipmentId, equipmentName: a.equipment.name, accessId: a.id, key: a.key, label: a.label,
      kind: dto.kind, policy: dto.policy, enabled: a.enabled, cableSerial: dto.cableSerial, cableName: dto.cableName, runtime: dto.runtime,
    }
  })
  return { settings: rt.accesses.settings(), hwServer: rt.accesses.hwServer(), ports, jtag: rt.accesses.jtag(), labels: rt.accesses.labels() }
}

/** Cables (admin): the inventory, what is connected now and hw_server. */
export async function getCablesPage(user: AuthUser): Promise<CablesPageDTO> {
  requireAdmin(user)
  const rt = getRuntime()
  return { labels: rt.accesses.labels(), jtag: rt.accesses.jtag(), serial: rt.serial.discovery.toDTO(), hwServer: rt.accesses.hwServer(), netAdapters: rt.equipnet.adapters() }
}
