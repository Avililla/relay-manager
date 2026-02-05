/**
 * Relay Manager
 *
 * @author Alejandro Avila Marcos
 * Made with ❤️ for dev team Valdepeñas
 */

"use client"

import { useState, useEffect, useCallback, useRef } from "react"

interface RelayState {
  [boardId: string]: string
}

interface BoardConnections {
  [boardId: string]: boolean
}

interface LockInfo {
  lockedById: string | null
  lockedBy: { id: string; email: string; name: string } | null
  lockExpiresAt: Date | null
}

interface LockState {
  [equipmentId: string]: LockInfo
}

export function useRelayState() {
  const [states, setStates] = useState<RelayState>({})
  const [connections, setConnections] = useState<BoardConnections>({})
  const [locks, setLocks] = useState<LockState>({})
  const [sseConnected, setSseConnected] = useState(false)
  const eventSourceRef = useRef<EventSource | null>(null)
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const pingIntervalRef = useRef<NodeJS.Timeout | null>(null)

  // Verificar conexión con las placas físicas
  const checkConnections = useCallback(async () => {
    try {
      const response = await fetch("/api/relay/ping")
      if (response.ok) {
        const data = await response.json()
        setConnections(data)
      }
    } catch (error) {
      console.error("[Relay] Error checking connections:", error)
    }
  }, [])

  const connect = useCallback(() => {
    // Limpiar conexión anterior
    if (eventSourceRef.current) {
      eventSourceRef.current.close()
    }
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current)
    }

    const eventSource = new EventSource("/api/relay/events")
    eventSourceRef.current = eventSource

    eventSource.onopen = () => {
      setSseConnected(true)
      // Verificar conexiones cuando SSE se conecta
      checkConnections()
    }

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)

        if (data.type === "relay") {
          // Evento de estado de relés
          const { boardId, state } = data
          setStates((prev) => ({
            ...prev,
            [boardId]: state,
          }))
          // Si recibimos un mensaje, la placa está conectada
          setConnections((prev) => ({
            ...prev,
            [boardId]: true,
          }))
        } else if (data.type === "lock") {
          // Evento de bloqueo de equipo
          const { equipmentId, lockedById, lockedBy, lockExpiresAt } = data
          setLocks((prev) => ({
            ...prev,
            [equipmentId]: {
              lockedById,
              lockedBy,
              lockExpiresAt: lockExpiresAt ? new Date(lockExpiresAt) : null,
            },
          }))
        }
      } catch (error) {
        console.error("[SSE] Error parsing message:", error)
      }
    }

    eventSource.onerror = () => {
      setSseConnected(false)
      eventSource.close()

      // Reconectar después de 3 segundos
      reconnectTimeoutRef.current = setTimeout(() => {
        connect()
      }, 3000)
    }
  }, [checkConnections])

  useEffect(() => {
    connect()

    // Verificar conexiones cada 10 segundos
    pingIntervalRef.current = setInterval(checkConnections, 10000)

    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close()
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current)
      }
      if (pingIntervalRef.current) {
        clearInterval(pingIntervalRef.current)
      }
    }
  }, [connect, checkConnections])

  const getBoardState = useCallback(
    (boardId: string): string => {
      return states[boardId] || "00000000"
    },
    [states]
  )

  const getRelayState = useCallback(
    (boardId: string, relayIndex: number): boolean => {
      const state = states[boardId] || "00000000"
      return state[relayIndex] === "1"
    },
    [states]
  )

  const isBoardConnected = useCallback(
    (boardId: string): boolean => {
      return connections[boardId] ?? false
    },
    [connections]
  )

  const getLockState = useCallback(
    (equipmentId: string): LockInfo | null => {
      return locks[equipmentId] || null
    },
    [locks]
  )

  return {
    states,
    setStates,
    connections,
    locks,
    setLocks,
    sseConnected,
    getBoardState,
    getRelayState,
    isBoardConnected,
    getLockState,
    checkConnections,
  }
}
