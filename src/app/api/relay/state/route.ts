/**
 * Relay Manager
 *
 * @author Alejandro Avila Marcos
 * Made with ❤️ for dev team Valdepeñas
 */

import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/prisma"

// GET /api/relay/state - Obtener estado de todas las placas desde la BD
export async function GET(request: NextRequest) {
  const session = await auth()

  if (!session?.user) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 })
  }

  try {
    const boardId = request.nextUrl.searchParams.get("boardId")

    if (boardId) {
      // Estado de una placa específica
      const board = await prisma.relayBoard.findUnique({
        where: { id: boardId },
        select: { id: true, relayState: true },
      })

      if (!board) {
        return NextResponse.json({ error: "Placa no encontrada" }, { status: 404 })
      }

      return NextResponse.json({ [board.id]: board.relayState })
    }

    // Estado de todas las placas
    const boards = await prisma.relayBoard.findMany({
      select: { id: true, relayState: true },
    })

    const states: Record<string, string> = {}
    for (const board of boards) {
      states[board.id] = board.relayState
    }

    return NextResponse.json(states)
  } catch (error) {
    console.error("Error getting relay state:", error)
    return NextResponse.json(
      { error: "Error al obtener estado" },
      { status: 500 }
    )
  }
}
