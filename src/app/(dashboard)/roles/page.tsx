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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Plus, Shield } from "lucide-react"

export default async function RolesPage() {
  const session = await auth()

  if (!session?.user?.isAdmin) {
    redirect("/")
  }

  const roles = await getRoles()

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Roles</h1>
          <p className="text-muted-foreground">
            Gestiona los roles para control de acceso
          </p>
        </div>
        <Link href="/roles/new">
          <Button>
            <Plus className="mr-2 h-4 w-4" />
            Nuevo Rol
          </Button>
        </Link>
      </div>

      {roles.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Shield className="h-12 w-12 text-muted-foreground mb-4" />
            <p className="text-muted-foreground">No hay roles configurados</p>
            <Link href="/roles/new" className="mt-4">
              <Button variant="outline">Crear primer rol</Button>
            </Link>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Listado de Roles</CardTitle>
            <CardDescription>
              {roles.length} rol(es) configurado(s)
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <div className="max-h-[60vh] overflow-auto custom-scrollbar">
            <Table>
              <TableHeader className="sticky top-0 bg-card z-10">
                <TableRow>
                  <TableHead>Nombre</TableHead>
                  <TableHead>Descripción</TableHead>
                  <TableHead>Usuarios</TableHead>
                  <TableHead>Equipos</TableHead>
                  <TableHead className="w-[100px]">Acciones</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {roles.map((role) => (
                  <TableRow key={role.id}>
                    <TableCell className="font-medium">{role.name}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {role.description || "-"}
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary">{role._count.users}</Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{role._count.equipments}</Badge>
                    </TableCell>
                    <TableCell>
                      <Link href={`/roles/${role.id}`}>
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
