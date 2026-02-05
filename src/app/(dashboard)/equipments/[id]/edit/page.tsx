/**
 * Relay Manager
 *
 * @author Alejandro Avila Marcos
 * Made with ❤️ for dev team Valdepeñas
 */

import Link from "next/link"
import { notFound, redirect } from "next/navigation"
import { auth } from "@/lib/auth"
import { getEquipment, getBoardsForEquipment } from "@/actions/equipments"
import { getEquipmentTypes } from "@/actions/equipment-types"
import { getRoles } from "@/actions/roles"
import { getSerialPorts } from "@/actions/serial-ports"
import { Button } from "@/components/ui/button"
import { ArrowLeft } from "lucide-react"
import { EquipmentForm } from "../../equipment-form"
import { SerialPortsConfig } from "@/components/equipments/serial-ports-config"

export default async function EditEquipmentPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const session = await auth()

  if (!session?.user?.isAdmin) {
    redirect("/equipments")
  }

  const [equipment, boards, equipmentTypes, roles, serialPorts] = await Promise.all([
    getEquipment(id),
    getBoardsForEquipment(),
    getEquipmentTypes(),
    getRoles(),
    getSerialPorts(id),
  ])

  if (!equipment) {
    notFound()
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link href={`/equipments/${id}`}>
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-3xl font-bold">Editar Equipo</h1>
          <p className="text-muted-foreground">
            Modifica la configuración de {equipment.name}
          </p>
        </div>
      </div>

      <EquipmentForm
        boards={boards}
        equipmentTypes={equipmentTypes}
        roles={roles}
        initialData={{
          id: equipment.id,
          name: equipment.name,
          description: equipment.description,
          serialNumber: equipment.serialNumber,
          typeId: equipment.typeId,
          boardId: equipment.boardId,
          startRelay: equipment.startRelay,
          relayCount: equipment.type.relayCount,
          roles: equipment.roles,
        }}
      />

      {equipment.type.serialPortCount > 0 && (
        <SerialPortsConfig
          equipmentId={equipment.id}
          serialPortCount={equipment.type.serialPortCount}
          existingPorts={serialPorts}
        />
      )}
    </div>
  )
}
