import { EquipmentProvider, type EquipmentHeaderData } from "@/components/workspace/equipment-context"
import { EquipmentHeader, ReservationExpiryAlert } from "@/components/workspace/equipment-header"
import { loadWorkspace } from "./workspace-data"

/**
 * Equipo workspace frame (§8.9): full height (main minus the chrome), header with the reservation bar and the
 * route tabs (Consolas, Actividad, Ajustes for admins). A missing or invisible unit renders only the page, which
 * calls notFound() so this segment's not-found.tsx answers.
 */
export default async function EquipoLayout({ children, params }: { children: React.ReactNode; params: Promise<{ id: string }> }) {
  const { id } = await params
  const { data } = await loadWorkspace(id)
  if (!data) return children
  const header: EquipmentHeaderData = {
    id: data.id,
    name: data.name,
    serialNumber: data.serialNumber,
    templateName: data.templateName,
    description: data.description,
    consoleCount: data.consoles.length,
    relayCount: data.relays.length,
    reservation: data.reservation,
    consoles: data.consoles.map((c) => ({ id: c.id, key: c.key, runtime: c.runtime })),
    accesses: data.accesses.map((a) => ({ id: a.id, key: a.key, label: a.label, kind: a.kind, policy: a.policy, runtime: a.runtime })),
  }
  return (
    <EquipmentProvider equipment={header}>
      <div className="flex h-full min-h-0 flex-col">
        <EquipmentHeader />
        <ReservationExpiryAlert className="mx-2 mt-2 shrink-0 md:mx-3" />
        <div className="relative min-h-0 flex-1 overflow-y-auto">{children}</div>
      </div>
    </EquipmentProvider>
  )
}
