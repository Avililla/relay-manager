/**
 * Relay Manager
 *
 * @author Alejandro Avila Marcos
 * Made with ❤️ for dev team Valdepeñas
 */

import Link from "next/link"
import { notFound, redirect } from "next/navigation"
import { auth } from "@/lib/auth"
import { getRole } from "@/actions/roles"
import { Button } from "@/components/ui/button"
import { ArrowLeft } from "lucide-react"
import { RoleForm } from "../../role-form"

export default async function EditRolePage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const session = await auth()

  if (!session?.user?.isAdmin) {
    redirect("/roles")
  }

  const role = await getRole(id)

  if (!role) {
    notFound()
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link href={`/roles/${id}`}>
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-3xl font-bold">Editar Rol</h1>
          <p className="text-muted-foreground">
            Modifica la configuración de {role.name}
          </p>
        </div>
      </div>

      <RoleForm
        initialData={{
          id: role.id,
          name: role.name,
          description: role.description,
        }}
      />
    </div>
  )
}
