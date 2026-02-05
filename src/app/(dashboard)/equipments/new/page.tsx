/**
 * Relay Manager
 *
 * @author Alejandro Avila Marcos
 * Made with ❤️ for dev team Valdepeñas
 */

import Link from "next/link"
import { redirect } from "next/navigation"
import { auth } from "@/lib/auth"
import { getBoardsForEquipment } from "@/actions/equipments"
import { getEquipmentTypes } from "@/actions/equipment-types"
import { getRoles } from "@/actions/roles"
import { Button } from "@/components/ui/button"
import { ArrowLeft } from "lucide-react"
import { EquipmentForm } from "../equipment-form"

export default async function NewEquipmentPage() {
  const session = await auth()

  if (!session?.user?.isAdmin) {
    redirect("/equipments")
  }

  const [boards, equipmentTypes, roles] = await Promise.all([
    getBoardsForEquipment(),
    getEquipmentTypes(),
    getRoles(),
  ])

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link href="/equipments">
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-3xl font-bold">Nuevo Equipo</h1>
          <p className="text-muted-foreground">
            Asigna un nuevo equipo a una placa de relés
          </p>
        </div>
      </div>

      <EquipmentForm boards={boards} equipmentTypes={equipmentTypes} roles={roles} />
    </div>
  )
}
