/**
 * Relay Manager
 *
 * @author Alejandro Avila Marcos
 * Made with ❤️ for dev team Valdepeñas
 */

import Link from "next/link"
import { notFound } from "next/navigation"
import { auth } from "@/lib/auth"
import { getEquipment } from "@/actions/equipments"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { ArrowLeft, Edit, Terminal } from "lucide-react"
import { DeleteEquipmentButton } from "./delete-button"
import { RelayControl } from "./relay-control"

export default async function EquipmentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const session = await auth()
  const equipment = await getEquipment(id)

  if (!equipment) {
    notFound()
  }

  // Parse relay config labels
  let relayLabels: Array<{ label: string; purpose: string }> = []
  try {
    relayLabels = JSON.parse(equipment.type.relayConfig)
  } catch {
    relayLabels = Array.from(
      { length: equipment.type.relayCount },
      (_, i) => ({ label: `Relé ${i + 1}`, purpose: "unknown" })
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link href="/">
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div className="flex-1">
          <h1 className="text-3xl font-bold">{equipment.name}</h1>
          <div className="flex items-center gap-2 mt-1">
            <Badge variant="outline">{equipment.type.name}</Badge>
            {equipment.serialNumber && (
              <span className="text-sm text-muted-foreground font-mono">
                S/N: {equipment.serialNumber}
              </span>
            )}
          </div>
        </div>
        <div className="flex gap-2">
          {equipment.type.serialPortCount > 0 && (
            <Link href={`/equipments/${id}/serial`}>
              <Button variant="outline">
                <Terminal className="mr-2 h-4 w-4" />
                Consola
              </Button>
            </Link>
          )}
          {session?.user?.isAdmin && (
            <>
              <Link href={`/equipments/${id}/edit`}>
                <Button variant="outline">
                  <Edit className="mr-2 h-4 w-4" />
                  Editar
                </Button>
              </Link>
              <DeleteEquipmentButton id={id} name={equipment.name} />
            </>
          )}
        </div>
      </div>

      {/* Descripción si existe */}
      {equipment.description && (
        <Card>
          <CardHeader>
            <CardTitle>Descripción</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground">{equipment.description}</p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Control de Relés</CardTitle>
          <CardDescription>
            Controla los {equipment.type.relayCount} relés asignados a este equipo
          </CardDescription>
        </CardHeader>
        <CardContent>
          <RelayControl
            equipment={{
              id: equipment.id,
              name: equipment.name,
              startRelay: equipment.startRelay,
              relayCount: equipment.type.relayCount,
              relayLabels,
            }}
            board={{
              id: equipment.board.id,
              ipAddress: equipment.board.ipAddress,
            }}
          />
        </CardContent>
      </Card>
    </div>
  )
}
