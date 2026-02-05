/**
 * Relay Manager
 *
 * @author Alejandro Avila Marcos
 * Made with ❤️ for dev team Valdepeñas
 */

import Link from "next/link"
import { redirect } from "next/navigation"
import { auth } from "@/lib/auth"
import { getUsers } from "@/actions/users"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Plus, Users } from "lucide-react"

export default async function UsersPage() {
  const session = await auth()

  if (!session?.user?.isAdmin) {
    redirect("/")
  }

  const users = await getUsers()

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Usuarios</h1>
          <p className="text-muted-foreground">
            Gestiona los usuarios del sistema
          </p>
        </div>
        <Link href="/users/new">
          <Button>
            <Plus className="mr-2 h-4 w-4" />
            Nuevo Usuario
          </Button>
        </Link>
      </div>

      {users.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Users className="h-12 w-12 text-muted-foreground mb-4" />
            <p className="text-muted-foreground">No hay usuarios registrados</p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Listado de Usuarios</CardTitle>
            <CardDescription>
              {users.length} usuario(s) registrado(s)
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <div className="max-h-[60vh] overflow-auto custom-scrollbar">
            <Table>
              <TableHeader className="sticky top-0 bg-card z-10">
                <TableRow>
                  <TableHead>Nombre</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Tipo</TableHead>
                  <TableHead>Rol</TableHead>
                  <TableHead className="w-[100px]">Acciones</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.map((user) => (
                  <TableRow key={user.id}>
                    <TableCell className="font-medium">{user.name}</TableCell>
                    <TableCell>{user.email}</TableCell>
                    <TableCell>
                      <Badge variant={user.isAdmin ? "default" : "secondary"}>
                        {user.isAdmin ? "Admin" : "Usuario"}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {user.roles.length > 0 ? (
                        <div className="flex flex-wrap gap-1">
                          {user.roles.map((role) => (
                            <Link key={role.id} href={`/roles/${role.id}`}>
                              <Badge variant="outline" className="cursor-pointer">
                                {role.name}
                              </Badge>
                            </Link>
                          ))}
                        </div>
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Link href={`/users/${user.id}`}>
                        <Button variant="ghost" size="sm">
                          Ver
                        </Button>
                      </Link>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
