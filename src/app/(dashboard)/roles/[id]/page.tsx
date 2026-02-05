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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { ArrowLeft, Edit } from "lucide-react"
import { DeleteRoleButton } from "./delete-button"

export default async function RoleDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const session = await auth()

  if (!session?.user?.isAdmin) {
    redirect("/")
  }

  const role = await getRole(id)

  if (!role) {
    notFound()
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link href="/roles">
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div className="flex-1">
          <h1 className="text-3xl font-bold">{role.name}</h1>
          <p className="text-muted-foreground">
            {role.description || "Sin descripción"}
          </p>
        </div>
        <div className="flex gap-2">
          <Link href={`/roles/${id}/edit`}>
            <Button variant="outline">
              <Edit className="mr-2 h-4 w-4" />
              Editar
            </Button>
          </Link>
          <DeleteRoleButton
            id={id}
            name={role.name}
            userCount={role.users.length}
            equipmentCount={role.equipments.length}
          />
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Usuarios con este rol</CardTitle>
            <CardDescription>
              {role.users.length} usuario(s) asignado(s)
            </CardDescription>
          </CardHeader>
          <CardContent>
            {role.users.length === 0 ? (
              <p className="text-center text-muted-foreground py-4">
                No hay usuarios con este rol
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Nombre</TableHead>
                    <TableHead>Email</TableHead>
                    <TableHead>Tipo</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {role.users.map((user) => (
                    <TableRow key={user.id}>
                      <TableCell>
                        <Link
                          href={`/users/${user.id}`}
                          className="font-medium text-primary hover:underline"
                        >
                          {user.name}
                        </Link>
                      </TableCell>
                      <TableCell>{user.email}</TableCell>
                      <TableCell>
                        <Badge variant={user.isAdmin ? "default" : "secondary"}>
                          {user.isAdmin ? "Admin" : "Usuario"}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Equipos asignados</CardTitle>
            <CardDescription>
              {role.equipments.length} equipo(s) visible(s) para este rol
            </CardDescription>
          </CardHeader>
          <CardContent>
            {role.equipments.length === 0 ? (
              <p className="text-center text-muted-foreground py-4">
                No hay equipos asignados a este rol
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Nombre</TableHead>
                    <TableHead>Tipo</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {role.equipments.map((equipment) => (
                    <TableRow key={equipment.id}>
                      <TableCell>
                        <Link
                          href={`/equipments/${equipment.id}`}
                          className="font-medium text-primary hover:underline"
                        >
                          {equipment.name}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary">{equipment.type.name}</Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
