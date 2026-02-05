/**
 * Relay Manager
 *
 * @author Alejandro Avila Marcos
 * Made with ❤️ for dev team Valdepeñas
 */

import { auth } from "@/lib/auth"
import { relayEvents } from "@/lib/relay-events"
import { prisma } from "@/lib/prisma"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function GET(): Promise<Response> {
  const session = await auth()

  if (!session?.user) {
    return new Response("No autorizado", { status: 401 })
  }

  const encoder = new TextEncoder()
  let unsubscribeRelay: (() => void) | null = null
  let unsubscribeLock: (() => void) | null = null
  let heartbeatInterval: NodeJS.Timeout | null = null
  let isClosed = false

  const stream = new ReadableStream({
    async start(controller) {

      // Enviar estado inicial de todas las placas
      try {
        const boards = await prisma.relayBoard.findMany({
          select: { id: true, relayState: true },
        })

        for (const board of boards) {
          if (isClosed) return
          const data = JSON.stringify({ type: "relay", boardId: board.id, state: board.relayState })
          controller.enqueue(encoder.encode(`data: ${data}\n\n`))
        }
      } catch (error) {
        console.error("[SSE] Error sending initial relay state:", error)
      }

      // Enviar estado inicial de bloqueos de equipos
      try {
        const equipments = await prisma.equipment.findMany({
          where: {
            lockedById: { not: null },
          },
          select: {
            id: true,
            lockedById: true,
            lockedBy: {
              select: { id: true, email: true, name: true },
            },
            lockExpiresAt: true,
          },
        })

        for (const equipment of equipments) {
          if (isClosed) return
          // Solo enviar si el bloqueo no ha expirado
          if (equipment.lockExpiresAt && equipment.lockExpiresAt > new Date()) {
            const data = JSON.stringify({
              type: "lock",
              equipmentId: equipment.id,
              lockedById: equipment.lockedById,
              lockedBy: equipment.lockedBy,
              lockExpiresAt: equipment.lockExpiresAt,
            })
            controller.enqueue(encoder.encode(`data: ${data}\n\n`))
          }
        }
      } catch (error) {
        console.error("[SSE] Error sending initial lock state:", error)
      }

      // Suscribirse a cambios de relés
      unsubscribeRelay = relayEvents.subscribeRelay((boardId, state) => {
        if (isClosed) return
        try {
          const data = JSON.stringify({ type: "relay", boardId, state })
          controller.enqueue(encoder.encode(`data: ${data}\n\n`))
        } catch (error) {
          console.error("[SSE] Error sending relay update:", error)
        }
      })

      // Suscribirse a cambios de bloqueos
      unsubscribeLock = relayEvents.subscribeLock((equipmentId, lockInfo) => {
        if (isClosed) return
        try {
          const data = JSON.stringify({
            type: "lock",
            equipmentId,
            ...lockInfo,
          })
          controller.enqueue(encoder.encode(`data: ${data}\n\n`))
        } catch (error) {
          console.error("[SSE] Error sending lock update:", error)
        }
      })

      // Heartbeat cada 30 segundos para mantener la conexión
      heartbeatInterval = setInterval(() => {
        if (isClosed) {
          if (heartbeatInterval) clearInterval(heartbeatInterval)
          return
        }
        try {
          controller.enqueue(encoder.encode(`: heartbeat\n\n`))
        } catch {
          if (heartbeatInterval) clearInterval(heartbeatInterval)
        }
      }, 30000)
    },
    cancel() {
      isClosed = true
      if (heartbeatInterval) {
        clearInterval(heartbeatInterval)
        heartbeatInterval = null
      }
      if (unsubscribeRelay) {
        unsubscribeRelay()
        unsubscribeRelay = null
      }
      if (unsubscribeLock) {
        unsubscribeLock()
        unsubscribeLock = null
      }
    },
  })

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  })
}
