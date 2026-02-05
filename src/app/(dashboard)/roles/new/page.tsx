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
import { RoleForm } from "../role-form"

export default async function NewRolePage() {
  const session = await auth()

  if (!session?.user?.isAdmin) {
    redirect("/roles")
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link href="/roles">
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-3xl font-bold">Nuevo Rol</h1>
          <p className="text-muted-foreground">
            Crea un nuevo rol para controlar el acceso
          </p>
        </div>
      </div>

      <RoleForm />
    </div>
  )
}
