/**
 * Relay Manager
 *
 * @author Alejandro Avila Marcos
 * Made with ❤️ for dev team Valdepeñas
 */

import Link from "next/link"
import { auth } from "@/lib/auth"
import { getEquipmentTypes } from "@/actions/equipment-types"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Plus, Package } from "lucide-react"

export default async function EquipmentTypesPage() {
  const session = await auth()
  const equipmentTypes = await getEquipmentTypes()

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Tipos de Equipo</h1>
          <p className="text-muted-foreground">
            Gestiona los diferentes tipos de equipos que se conectan a las placas
          </p>
        </div>
        {session?.user?.isAdmin && (
          <Link href="/equipment-types/new">
            <Button>
              <Plus className="mr-2 h-4 w-4" />
              Nuevo Tipo
            </Button>
          </Link>
        )}
      </div>

      {equipmentTypes.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Package className="h-12 w-12 text-muted-foreground mb-4" />
            <p className="text-muted-foreground">No hay tipos de equipo configurados</p>
            {session?.user?.isAdmin && (
              <Link href="/equipment-types/new" className="mt-4">
                <Button variant="outline">Crear primer tipo</Button>
              </Link>
            )}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Listado de Tipos</CardTitle>
            <CardDescription>
              {equipmentTypes.length} tipo(s) de equipo registrado(s)
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <div className="max-h-[60vh] overflow-auto custom-scrollbar">
            <Table>
              <TableHeader className="sticky top-0 bg-card z-10">
                <TableRow>
                  <TableHead>Nombre</TableHead>
                  <TableHead>Descripción</TableHead>
                  <TableHead>Relés</TableHead>
                  <TableHead>Equipos</TableHead>
                  <TableHead className="w-[100px]">Acciones</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {equipmentTypes.map((type) => (
                  <TableRow key={type.id}>
                    <TableCell className="font-medium">{type.name}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {type.description || "-"}
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary">{type.relayCount}</Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{type._count.equipments}</Badge>
                    </TableCell>
                    <TableCell>
                      <Link href={`/equipment-types/${type.id}`}>
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
