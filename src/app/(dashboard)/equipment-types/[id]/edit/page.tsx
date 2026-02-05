/**
 * Relay Manager
 *
 * @author Alejandro Avila Marcos
 * Made with ❤️ for dev team Valdepeñas
 */

import Link from "next/link"
import { notFound, redirect } from "next/navigation"
import { auth } from "@/lib/auth"
import { getEquipmentType } from "@/actions/equipment-types"
import { Button } from "@/components/ui/button"
import { ArrowLeft } from "lucide-react"
import { EquipmentTypeForm } from "../../equipment-type-form"

export default async function EditEquipmentTypePage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const session = await auth()

  if (!session?.user?.isAdmin) {
    redirect("/equipment-types")
  }

  const equipmentType = await getEquipmentType(id)

  if (!equipmentType) {
    notFound()
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link href={`/equipment-types/${id}`}>
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-3xl font-bold">Editar Tipo de Equipo</h1>
          <p className="text-muted-foreground">
            Modifica la configuración de {equipmentType.name}
          </p>
        </div>
      </div>

      <EquipmentTypeForm
        initialData={{
          id: equipmentType.id,
          name: equipmentType.name,
          description: equipmentType.description,
          relayCount: equipmentType.relayCount,
          relayConfig: equipmentType.relayConfig,
          serialPortCount: equipmentType.serialPortCount,
        }}
      />
    </div>
  )
}
