/**
 * Relay Manager
 *
 * @author Alejandro Avila Marcos
 * Made with ❤️ for dev team Valdepeñas
 */

import Link from "next/link"
import { auth } from "@/lib/auth"
import { getBoards } from "@/actions/boards"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { BoardsListLive } from "@/components/boards/boards-list-live"
import { Plus, Server } from "lucide-react"

export default async function BoardsPage() {
  const session = await auth()
  const boards = await getBoards()

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Placas de Reles</h1>
          <p className="text-muted-foreground">
            Gestiona tus placas Devantech y sus equipos asignados
          </p>
        </div>
        {session?.user?.isAdmin && (
          <Link href="/boards/new">
            <Button>
              <Plus className="mr-2 h-4 w-4" />
              Nueva Placa
            </Button>
          </Link>
        )}
      </div>

      {boards.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Server className="h-12 w-12 text-muted-foreground mb-4" />
            <p className="text-muted-foreground">No hay placas configuradas</p>
            {session?.user?.isAdmin && (
              <Link href="/boards/new" className="mt-4">
                <Button variant="outline">Crear primera placa</Button>
              </Link>
            )}
          </CardContent>
        </Card>
      ) : (
        <BoardsListLive boards={boards} />
      )}
    </div>
  )
}
