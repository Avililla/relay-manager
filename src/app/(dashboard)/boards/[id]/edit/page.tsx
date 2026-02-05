/**
 * Relay Manager
 *
 * @author Alejandro Avila Marcos
 * Made with ❤️ for dev team Valdepeñas
 */

import Link from "next/link"
import { notFound, redirect } from "next/navigation"
import { auth } from "@/lib/auth"
import { getBoard } from "@/actions/boards"
import { Button } from "@/components/ui/button"
import { ArrowLeft } from "lucide-react"
import { BoardForm } from "../../board-form"

export default async function EditBoardPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const session = await auth()

  if (!session?.user?.isAdmin) {
    redirect("/boards")
  }

  const board = await getBoard(id)

  if (!board) {
    notFound()
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link href={`/boards/${id}`}>
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-3xl font-bold">Editar Placa</h1>
          <p className="text-muted-foreground">
            Modifica la configuración de {board.name}
          </p>
        </div>
      </div>

      <BoardForm
        initialData={{
          id: board.id,
          name: board.name,
          ipAddress: board.ipAddress,
          totalRelays: board.totalRelays,
        }}
      />
    </div>
  )
}
