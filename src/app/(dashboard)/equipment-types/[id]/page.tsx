/**
 * Relay Manager
 *
 * @author Alejandro Avila Marcos
 * Made with ❤️ for dev team Valdepeñas
 */

import Link from "next/link"
import { notFound } from "next/navigation"
import { auth } from "@/lib/auth"
import { getEquipmentType } from "@/actions/equipment-types"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { ArrowLeft, Edit } from "lucide-react"
import { DeleteEquipmentTypeButton } from "./delete-button"

export default async function EquipmentTypeDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const session = await auth()
  const equipmentType = await getEquipmentType(id)

  if (!equipmentType) {
    notFound()
  }

  // Parse relay config
  interface RelayLabel {
    index?: number
    purpose?: string
    label: string
  }

  let relayLabels: RelayLabel[] = []
  try {
    const parsed = JSON.parse(equipmentType.relayConfig)
    // Handle both old format (string[]) and new format (object[])
    if (Array.isArray(parsed)) {
      relayLabels = parsed.map((item, i) => {
        if (typeof item === "string") {
          return { label: item, index: i, purpose: "general" }
        }
        return item as RelayLabel
      })
    }
  } catch {
    relayLabels = Array.from({ length: equipmentType.relayCount }, (_, i) => ({
      label: `Relé ${i + 1}`,
      index: i,
      purpose: "general",
    }))
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link href="/equipment-types">
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div className="flex-1">
          <h1 className="text-3xl font-bold">{equipmentType.name}</h1>
          <p className="text-muted-foreground">
            {equipmentType.description || "Sin descripción"}
          </p>
        </div>
        {session?.user?.isAdmin && (
          <div className="flex gap-2">
            <Link href={`/equipment-types/${id}/edit`}>
              <Button variant="outline">
                <Edit className="mr-2 h-4 w-4" />
                Editar
              </Button>
            </Link>
            <DeleteEquipmentTypeButton
              id={id}
              name={equipmentType.name}
              equipmentCount={equipmentType.equipments.length}
            />
          </div>
        )}
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Información</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <p className="text-sm text-muted-foreground">Nombre</p>
              <p className="font-medium">{equipmentType.name}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Descripción</p>
              <p className="font-medium">{equipmentType.description || "-"}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Relés necesarios</p>
              <Badge variant="secondary">{equipmentType.relayCount}</Badge>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Configuración de Relés</CardTitle>
            <CardDescription>
              Etiquetas asignadas a cada relé del equipo
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {relayLabels.map((item, index) => (
                <div
                  key={index}
                  className="flex items-center gap-3 p-2 bg-muted rounded-md"
                >
                  <Badge variant="outline">{index + 1}</Badge>
                  <span className="text-sm">{item.label}</span>
                  {item.purpose && item.purpose !== "general" && (
                    <Badge variant="secondary" className="text-xs">
                      {item.purpose}
                    </Badge>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Equipos de este tipo</CardTitle>
          <CardDescription>
            {equipmentType.equipments.length} equipo(s) registrado(s)
          </CardDescription>
        </CardHeader>
        <CardContent>
          {equipmentType.equipments.length === 0 ? (
            <p className="text-center text-muted-foreground py-8">
              No hay equipos de este tipo
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Nombre</TableHead>
                  <TableHead>Placa</TableHead>
                  <TableHead>Relé inicial</TableHead>
                  <TableHead className="w-[100px]">Acciones</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {equipmentType.equipments.map((equipment) => (
                  <TableRow key={equipment.id}>
                    <TableCell className="font-medium">{equipment.name}</TableCell>
                    <TableCell>
                      <Link
                        href={`/boards/${equipment.board.id}`}
                        className="text-primary hover:underline"
                      >
                        {equipment.board.name}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{equipment.startRelay}</Badge>
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
          )}
        </CardContent>
      </Card>
    </div>
  )
}
