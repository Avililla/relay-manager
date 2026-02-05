/**
 * Relay Manager
 *
 * @author Alejandro Avila Marcos
 * Made with ❤️ for dev team Valdepeñas
 */

import Link from "next/link"
import { notFound } from "next/navigation"
import { auth } from "@/lib/auth"
import { getBoard } from "@/actions/boards"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { RelayBoardVisualLive } from "@/components/boards/relay-board-visual-live"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ArrowLeft, Edit, Plus } from "lucide-react"
import { DeleteBoardButton } from "./delete-button"

export default async function BoardDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const session = await auth()
  const board = await getBoard(id)

  if (!board) {
    notFound()
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link href="/boards">
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div className="flex-1">
          <h1 className="text-3xl font-bold">{board.name}</h1>
          <p className="text-muted-foreground">
            {board.ipAddress}
          </p>
        </div>
        {session?.user?.isAdmin && (
          <div className="flex gap-2">
            <Link href={`/boards/${id}/edit`}>
              <Button variant="outline">
                <Edit className="mr-2 h-4 w-4" />
                Editar
              </Button>
            </Link>
            <DeleteBoardButton id={id} name={board.name} />
          </div>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Estado de Relés</CardTitle>
            <CardDescription>
              Visualización de los {board.totalRelays} relés de la placa
            </CardDescription>
          </CardHeader>
          <CardContent>
            <RelayBoardVisualLive
              boardId={board.id}
              totalRelays={board.totalRelays}
              equipments={board.equipments}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Información</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <p className="text-sm text-muted-foreground">Dirección IP</p>
              <p className="font-medium">{board.ipAddress}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Total de relés</p>
              <p className="font-medium">{board.totalRelays}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Tipo</p>
              <Badge>Devantech</Badge>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle>Equipos Asignados</CardTitle>
            <CardDescription>
              {board.equipments.length} equipo(s) en esta placa
            </CardDescription>
          </div>
          {session?.user?.isAdmin && (
            <Link href={`/equipments/new?boardId=${id}`}>
              <Button>
                <Plus className="mr-2 h-4 w-4" />
                Asignar Equipo
              </Button>
            </Link>
          )}
        </CardHeader>
        <CardContent>
          {board.equipments.length === 0 ? (
            <p className="text-center text-muted-foreground py-8">
              No hay equipos asignados a esta placa
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Nombre</TableHead>
                  <TableHead>Tipo</TableHead>
                  <TableHead>Relés</TableHead>
                  <TableHead className="w-[100px]">Acciones</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {board.equipments.map((equipment) => (
                  <TableRow key={equipment.id}>
                    <TableCell className="font-medium">
                      {equipment.name}
                    </TableCell>
                    <TableCell>{equipment.type.name}</TableCell>
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
          )}
        </CardContent>
      </Card>
    </div>
  )
}
