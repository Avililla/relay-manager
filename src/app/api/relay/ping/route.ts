/**
 * Relay Manager
 *
 * @author Alejandro Avila Marcos
 * Made with ❤️ for dev team Valdepeñas
 */

import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { checkBoardConnection, checkAllBoardConnections } from "@/lib/relay-service"

// GET /api/relay/ping - Verificar conexión con placas
export async function GET(request: NextRequest) {
  const session = await auth()

  if (!session?.user) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 })
  }

  try {
    const boardId = request.nextUrl.searchParams.get("boardId")

    if (boardId) {
      // Verificar una placa específica
      const connected = await checkBoardConnection(boardId)
      return NextResponse.json({ [boardId]: connected })
    }

    // Verificar todas las placas
    const connections = await checkAllBoardConnections()
    return NextResponse.json(connections)
  } catch (error) {
    console.error("Error checking board connection:", error)
    return NextResponse.json(
      { error: "Error al verificar conexión" },
      { status: 500 }
    )
  }
}
