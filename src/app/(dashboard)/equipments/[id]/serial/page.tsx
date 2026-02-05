/**
 * Relay Manager
 *
 * @author Alejandro Avila Marcos
 * Made with ❤️ for dev team Valdepeñas
 */

import Link from "next/link"
import { notFound } from "next/navigation"
import { prisma } from "@/lib/prisma"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ArrowLeft, Terminal } from "lucide-react"
import { SerialTerminalTabs } from "./serial-terminal-tabs"

export default async function EquipmentSerialPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params

  const equipment = await prisma.equipment.findUnique({
    where: { id },
    include: {
      type: true,
      serialPorts: {
        orderBy: { boardIndex: "asc" },
      },
    },
  })

  if (!equipment) {
    notFound()
  }

  const hasSerialPorts = equipment.serialPorts.length > 0
  const configuredPorts = equipment.serialPorts.filter((p) => p.serialId)

  return (
    <div className="flex flex-col h-[calc(100vh-8rem)] overflow-hidden">
      <div className="flex items-center gap-4 pb-4 shrink-0">
        <Link href={`/equipments/${id}`}>
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3">
            <Terminal className="h-5 w-5 text-muted-foreground shrink-0" />
            <h1 className="text-xl font-bold truncate">Consola Serial</h1>
            <Badge variant="outline" className="shrink-0">{equipment.name}</Badge>
          </div>
        </div>
      </div>

      {!hasSerialPorts || configuredPorts.length === 0 ? (
        <div className="flex flex-col items-center justify-center flex-1 text-center">
          <Terminal className="h-12 w-12 text-muted-foreground mb-4" />
          <h2 className="text-xl font-semibold mb-2">No hay puertos serial configurados</h2>
          <p className="text-muted-foreground mb-4">
            Configura los puertos serial en la edición del equipo para usar la consola.
          </p>
          <Link href={`/equipments/${id}/edit`}>
            <Button>Configurar puertos</Button>
          </Link>
        </div>
      ) : (
        <div className="flex-1 min-h-0">
          <SerialTerminalTabs serialPorts={configuredPorts} />
        </div>
      )}
    </div>
  )
}
