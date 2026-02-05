/**
 * Relay Manager
 *
 * @author Alejandro Avila Marcos
 * Made with ❤️ for dev team Valdepeñas
 */

import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { toggleRelay, getBoardState, syncBoardState } from "@/lib/relay-service"

// POST /api/relay - Toggle de un relé (pulso)
export async function POST(request: NextRequest) {
  const session = await auth()

  if (!session?.user) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 })
  }

  try {
    const { boardId, relayIndex } = await request.json()

    if (!boardId || relayIndex === undefined) {
      return NextResponse.json(
        { error: "boardId y relayIndex son requeridos" },
        { status: 400 }
      )
    }

    const newState = await toggleRelay(boardId, relayIndex)

    return NextResponse.json({ success: true, state: newState })
  } catch (error) {
    console.error("Relay API error:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Error al comunicar con la placa" },
      { status: 500 }
    )
  }
}

// GET /api/relay?boardId=xxx - Obtener estado de la placa
export async function GET(request: NextRequest) {
  const session = await auth()

  if (!session?.user) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 })
  }

  try {
    const boardId = request.nextUrl.searchParams.get("boardId")
    const sync = request.nextUrl.searchParams.get("sync") === "true"

    if (!boardId) {
      return NextResponse.json(
        { error: "boardId es requerido" },
        { status: 400 }
      )
    }

    const state = sync ? await syncBoardState(boardId) : await getBoardState(boardId)

    return NextResponse.json({ success: true, state })
  } catch (error) {
    console.error("Relay API error:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Error al obtener estado" },
      { status: 500 }
    )
  }
}
