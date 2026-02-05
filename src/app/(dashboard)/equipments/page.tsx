/**
 * Relay Manager
 *
 * @author Alejandro Avila Marcos
 * Made with ❤️ for dev team Valdepeñas
 */

import Link from "next/link"
import { auth } from "@/lib/auth"
import { getEquipments } from "@/actions/equipments"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Plus, Zap } from "lucide-react"

export default async function EquipmentsPage() {
  const session = await auth()
  const equipments = await getEquipments()

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Equipos</h1>
          <p className="text-muted-foreground">
            Gestiona los equipos conectados a las placas de relés
          </p>
        </div>
        {session?.user?.isAdmin && (
          <Link href="/equipments/new">
            <Button>
              <Plus className="mr-2 h-4 w-4" />
              Nuevo Equipo
            </Button>
          </Link>
        )}
      </div>

      {equipments.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Zap className="h-12 w-12 text-muted-foreground mb-4" />
            <p className="text-muted-foreground">No hay equipos configurados</p>
            {session?.user?.isAdmin && (
              <Link href="/equipments/new" className="mt-4">
                <Button variant="outline">Crear primer equipo</Button>
              </Link>
            )}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Listado de Equipos</CardTitle>
            <CardDescription>
              {equipments.length} equipo(s) registrado(s)
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <div className="max-h-[60vh] overflow-auto custom-scrollbar">
            <Table>
              <TableHeader className="sticky top-0 bg-card z-10">
                <TableRow>
                  <TableHead>Nombre</TableHead>
                  <TableHead>Tipo</TableHead>
                  <TableHead>Placa</TableHead>
                  <TableHead>Relés</TableHead>
                  <TableHead className="w-[100px]">Acciones</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {equipments.map((equipment) => (
                  <TableRow key={equipment.id}>
                    <TableCell className="font-medium">{equipment.name}</TableCell>
                    <TableCell>
                      <Badge variant="secondary">{equipment.type.name}</Badge>
                    </TableCell>
                    <TableCell>
                      <Link
                        href={`/boards/${equipment.board.id}`}
                        className="text-primary hover:underline"
                      >
                        {equipment.board.name}
                      </Link>
                    </TableCell>
                    <TableCell>
                      {equipment.startRelay} -{" "}
                      {equipment.startRelay + equipment.type.relayCount - 1}
                    </TableCell>
                    <TableCell>
                      <Link href={`/equipments/${equipment.id}`}>
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
