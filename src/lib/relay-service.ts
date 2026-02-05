/**
 * Relay Manager
 *
 * @author Alejandro Avila Marcos
 * Made with ❤️ for dev team Valdepeñas
 */

import { prisma } from "./prisma"
import { relayEvents } from "./relay-events"

// Mutex locks por placa para evitar condiciones de carrera
const boardLocks = new Map<string, Promise<void>>()

// Cache de estado para respuesta rápida (la placa sigue siendo la fuente de verdad)
const stateCache = new Map<string, { state: string; timestamp: number }>()
const CACHE_TTL = 2000 // 2 segundos - cache corto para UI rápida

// Intervalo de sincronización con placas físicas
const SYNC_INTERVAL = 5000 // 5 segundos
let syncIntervalId: NodeJS.Timeout | null = null

async function withLock<T>(boardId: string, fn: () => Promise<T>): Promise<T> {
  // Esperar a que termine cualquier operación pendiente en esta placa
  while (boardLocks.has(boardId)) {
    await boardLocks.get(boardId)
  }

  // Crear un nuevo lock
  let resolve: () => void
  const lockPromise = new Promise<void>((r) => {
    resolve = r
  })
  boardLocks.set(boardId, lockPromise)

  try {
    return await fn()
  } finally {
    boardLocks.delete(boardId)
    resolve!()
  }
}

// Parsear el XML de estado de la placa Devantech
function parseDevantechXml(xml: string, totalRelays: number = 8): string {
  // El XML tiene formato: <response><Rly1>0</Rly1><Rly2>1</Rly2>...</response>
  const state = []
  for (let i = 1; i <= totalRelays; i++) {
    const match = xml.match(new RegExp(`<Rly${i}>(\\d)</Rly${i}>`))
    state.push(match ? match[1] : "0")
  }
  return state.join("")
}

// Obtener estado actual de la placa desde el XML (desde la placa física)
export async function syncBoardState(boardId: string): Promise<string> {
  return withLock(boardId, async () => {
    const board = await prisma.relayBoard.findUnique({
      where: { id: boardId },
    })

    if (!board) {
      throw new Error("Placa no encontrada")
    }

    const response = await fetch(`http://${board.ipAddress}/index.xml`, {
      signal: AbortSignal.timeout(10000),
    })

    if (!response.ok) {
      throw new Error(`Error HTTP: ${response.status}`)
    }

    const xml = await response.text()
    const state = parseDevantechXml(xml, board.totalRelays)

    // Verificar si el estado cambió
    const cached = stateCache.get(boardId)
    const stateChanged = !cached || cached.state !== state

    // Actualizar cache
    stateCache.set(boardId, { state, timestamp: Date.now() })

    // Actualizar en BD
    await prisma.relayBoard.update({
      where: { id: boardId },
      data: { relayState: state },
    })

    // Emitir evento SSE solo si el estado cambió
    if (stateChanged) {
      relayEvents.emitRelay(boardId, state)
    }

    return state
  })
}

// Obtener estado - usa cache para respuesta rápida, sync periódico corrige
export async function getBoardState(boardId: string): Promise<string> {
  const cached = stateCache.get(boardId)

  // Si el cache es válido, devolver rápido
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.state
  }

  // Si no hay cache o expiró, sincronizar con la placa
  return syncBoardState(boardId)
}

// Sincronización periódica de todas las placas (background)
async function syncAllBoards(): Promise<void> {
  try {
    const boards = await prisma.relayBoard.findMany({
      select: { id: true, ipAddress: true, totalRelays: true },
    })

    await Promise.allSettled(
      boards.map(async (board) => {
        try {
          const response = await fetch(`http://${board.ipAddress}/index.xml`, {
            signal: AbortSignal.timeout(5000),
          })

          if (response.ok) {
            const xml = await response.text()
            const state = parseDevantechXml(xml, board.totalRelays)

            const cached = stateCache.get(board.id)
            const stateChanged = !cached || cached.state !== state

            // Actualizar cache
            stateCache.set(board.id, { state, timestamp: Date.now() })

            // Si cambió, actualizar BD y emitir SSE
            if (stateChanged) {
              await prisma.relayBoard.update({
                where: { id: board.id },
                data: { relayState: state },
              })
              relayEvents.emitRelay(board.id, state)
              console.log(`[Sync] Board ${board.ipAddress} state changed: ${state}`)
            }
          }
        } catch (error) {
          // Silencioso - la placa puede estar desconectada
        }
      })
    )
  } catch (error) {
    console.error("[Sync] Error syncing boards:", error)
  }
}

// Iniciar sincronización periódica
export function startPeriodicSync(): void {
  if (syncIntervalId) return // Ya está corriendo

  console.log(`[Sync] Starting periodic sync every ${SYNC_INTERVAL}ms`)
  syncIntervalId = setInterval(syncAllBoards, SYNC_INTERVAL)

  // Sync inicial
  syncAllBoards()
}

// Detener sincronización periódica
export function stopPeriodicSync(): void {
  if (syncIntervalId) {
    clearInterval(syncIntervalId)
    syncIntervalId = null
    console.log("[Sync] Stopped periodic sync")
  }
}

// Hacer toggle de un relé (pulso)
export async function toggleRelay(
  boardId: string,
  relayIndex: number
): Promise<string> {
  const board = await prisma.relayBoard.findUnique({
    where: { id: boardId },
  })

  if (!board) {
    throw new Error("Placa no encontrada")
  }

  if (relayIndex < 0 || relayIndex >= board.totalRelays) {
    throw new Error("Índice de relé inválido")
  }

  // Devantech usa pulsos con formato V20944=N donde N es el número de relé (1-8)
  // relayIndex es 0-based, así que sumamos 1 para obtener el número de relé
  const relayNumber = relayIndex + 1

  const url = `http://${board.ipAddress}/dscript.cgi?V20944=${relayNumber}`
  const response = await fetch(url, {
    signal: AbortSignal.timeout(10000),
  })

  if (!response.ok) {
    throw new Error(`Error HTTP: ${response.status}`)
  }

  // Actualización optimista del cache para respuesta rápida en UI
  const cached = stateCache.get(boardId)
  if (cached) {
    const optimisticState = cached.state.split("")
    optimisticState[relayIndex] = optimisticState[relayIndex] === "1" ? "0" : "1"
    const newState = optimisticState.join("")

    stateCache.set(boardId, { state: newState, timestamp: Date.now() })

    // Emitir SSE inmediatamente para UI rápida
    relayEvents.emitRelay(boardId, newState)

    // Actualizar BD
    await prisma.relayBoard.update({
      where: { id: boardId },
      data: { relayState: newState },
    })
  }

  // Verificar estado real después de un momento (el sync periódico corregirá si hay diferencia)
  setTimeout(() => {
    syncBoardState(boardId).catch(() => {})
  }, 200)

  return stateCache.get(boardId)?.state || board.relayState
}

// Obtener estado de un relé específico
export function getRelayState(boardState: string, relayIndex: number): boolean {
  return boardState[relayIndex] === "1"
}

// Verificar conexión con la placa
export async function checkBoardConnection(boardId: string): Promise<boolean> {
  const board = await prisma.relayBoard.findUnique({
    where: { id: boardId },
  })

  if (!board) {
    return false
  }

  try {
    const response = await fetch(`http://${board.ipAddress}/index.xml`, {
      signal: AbortSignal.timeout(3000),
    })
    return response.ok
  } catch {
    return false
  }
}

// Verificar conexión de todas las placas
export async function checkAllBoardConnections(): Promise<Record<string, boolean>> {
  const boards = await prisma.relayBoard.findMany({
    select: { id: true, ipAddress: true },
  })

  const results: Record<string, boolean> = {}

  await Promise.all(
    boards.map(async (board) => {
      try {
        const response = await fetch(`http://${board.ipAddress}/index.xml`, {
          signal: AbortSignal.timeout(3000),
        })
        results[board.id] = response.ok
      } catch {
        results[board.id] = false
      }
    })
  )

  return results
}
