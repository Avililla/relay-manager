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
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { ArrowLeft, Edit } from "lucide-react"
import { DeleteUserButton } from "./delete-button"

export default async function UserDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const session = await auth()

  if (!session?.user?.isAdmin) {
    redirect("/")
  }

  const user = await getUser(id)

  if (!user) {
    notFound()
  }

  const isCurrentUser = session.user.id === user.id

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link href="/users">
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div className="flex-1">
          <h1 className="text-3xl font-bold">{user.name}</h1>
          <p className="text-muted-foreground">{user.email}</p>
        </div>
        <div className="flex gap-2">
          <Link href={`/users/${id}/edit`}>
            <Button variant="outline">
              <Edit className="mr-2 h-4 w-4" />
              Editar
            </Button>
          </Link>
          {!isCurrentUser && <DeleteUserButton id={id} name={user.name} />}
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Información</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <p className="text-sm text-muted-foreground">Nombre</p>
              <p className="font-medium">{user.name}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Email</p>
              <p className="font-medium">{user.email}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Tipo de usuario</p>
              <Badge variant={user.isAdmin ? "default" : "secondary"}>
                {user.isAdmin ? "Administrador" : "Usuario"}
              </Badge>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Acceso</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <p className="text-sm text-muted-foreground">Roles asignados</p>
              {user.roles.length > 0 ? (
                <div className="flex flex-wrap gap-1 mt-1">
                  {user.roles.map((role) => (
                    <Link key={role.id} href={`/roles/${role.id}`}>
                      <Badge variant="outline" className="cursor-pointer">
                        {role.name}
                      </Badge>
                    </Link>
                  ))}
                </div>
              ) : (
                <p className="font-medium">Sin roles asignados</p>
              )}
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Permisos</p>
              <p className="text-sm mt-1">
                {user.isAdmin
                  ? "Acceso completo a todos los recursos"
                  : user.roles.length > 0
                    ? `Puede ver equipos públicos y los asignados a sus roles`
                    : "Solo puede ver equipos públicos (sin roles asignados)"}
              </p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Fecha de registro</p>
              <p className="font-medium">
                {new Date(user.createdAt).toLocaleDateString("es-ES", {
                  year: "numeric",
                  month: "long",
                  day: "numeric",
                })}
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
