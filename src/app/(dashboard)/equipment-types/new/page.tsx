/**
 * Relay Manager
 *
 * @author Alejandro Avila Marcos
 * Made with ❤️ for dev team Valdepeñas
 */

import Link from "next/link"
import { redirect } from "next/navigation"
import { auth } from "@/lib/auth"
import { Button } from "@/components/ui/button"
import { ArrowLeft } from "lucide-react"
import { EquipmentTypeForm } from "../equipment-type-form"

export default async function NewEquipmentTypePage() {
  const session = await auth()

  if (!session?.user?.isAdmin) {
    redirect("/equipment-types")
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link href="/equipment-types">
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-3xl font-bold">Nuevo Tipo de Equipo</h1>
          <p className="text-muted-foreground">
            Define un nuevo tipo de equipo para conectar a las placas
          </p>
        </div>
      </div>

      <EquipmentTypeForm />
    </div>
  )
}
