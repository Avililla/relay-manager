/**
 * Relay Manager
 *
 * @author Alejandro Avila Marcos
 * Made with ❤️ for dev team Valdepeñas
 */

import Link from "next/link"
import { redirect } from "next/navigation"
import { auth } from "@/lib/auth"
import { getRoles } from "@/actions/roles"
import { Button } from "@/components/ui/button"
import { ArrowLeft } from "lucide-react"
import { UserForm } from "../user-form"

export default async function NewUserPage() {
  const session = await auth()

  if (!session?.user?.isAdmin) {
    redirect("/users")
  }

  const roles = await getRoles()

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link href="/users">
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-3xl font-bold">Nuevo Usuario</h1>
          <p className="text-muted-foreground">
            Crea un nuevo usuario en el sistema
          </p>
        </div>
      </div>

      <UserForm roles={roles} />
    </div>
  )
}
