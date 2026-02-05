/**
 * Relay Manager
 *
 * @author Alejandro Avila Marcos
 * Made with ❤️ for dev team Valdepeñas
 */

import Link from "next/link"
import { notFound, redirect } from "next/navigation"
import { auth } from "@/lib/auth"
import { getUser } from "@/actions/users"
import { getRoles } from "@/actions/roles"
import { Button } from "@/components/ui/button"
import { ArrowLeft } from "lucide-react"
import { UserForm } from "../../user-form"

export default async function EditUserPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const session = await auth()

  if (!session?.user?.isAdmin) {
    redirect("/users")
  }

  const [user, roles] = await Promise.all([getUser(id), getRoles()])

  if (!user) {
    notFound()
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link href={`/users/${id}`}>
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-3xl font-bold">Editar Usuario</h1>
          <p className="text-muted-foreground">
            Modifica los datos de {user.name}
          </p>
        </div>
      </div>

      <UserForm
        roles={roles}
        initialData={{
          id: user.id,
          email: user.email,
          name: user.name,
          isAdmin: user.isAdmin,
          roles: user.roles,
        }}
      />
    </div>
  )
}
