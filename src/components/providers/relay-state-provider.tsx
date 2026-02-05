/**
 * Relay Manager
 *
 * @author Alejandro Avila Marcos
 * Made with ❤️ for dev team Valdepeñas
 */

"use client"

import { createContext, useContext, ReactNode, useCallback } from "react"
import { useRelayState } from "@/hooks/use-relay-state"

interface LockInfo {
  lockedById: string | null
  lockedBy: { id: string; email: string; name: string } | null
  lockExpiresAt: Date | null
}

interface RelayStateContextType {
  states: { [boardId: string]: string }
  connections: { [boardId: string]: boolean }
  locks: { [equipmentId: string]: LockInfo }
  sseConnected: boolean
  getBoardState: (boardId: string) => string
  getRelayState: (boardId: string, relayIndex: number) => boolean
  isBoardConnected: (boardId: string) => boolean
  getLockState: (equipmentId: string) => LockInfo | null
  updateLocalState: (boardId: string, relayIndex: number) => void
  updateLocalLock: (equipmentId: string, lockInfo: LockInfo) => void
  checkConnections: () => Promise<void>
}

const RelayStateContext = createContext<RelayStateContextType | null>(null)

export function RelayStateProvider({ children }: { children: ReactNode }) {
  const {
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
  } = useRelayState()

  // Actualización optimista local (toggle relay)
  const updateLocalState = useCallback((boardId: string, relayIndex: number) => {
    setStates((prev) => {
      const currentState = prev[boardId] || "00000000"
      const stateArray = currentState.split("")
      stateArray[relayIndex] = stateArray[relayIndex] === "1" ? "0" : "1"
      return {
        ...prev,
        [boardId]: stateArray.join(""),
      }
    })
  }, [setStates])

  // Actualización optimista local (lock)
  const updateLocalLock = useCallback((equipmentId: string, lockInfo: LockInfo) => {
    setLocks((prev) => ({
      ...prev,
      [equipmentId]: lockInfo,
    }))
  }, [setLocks])

  return (
    <RelayStateContext.Provider
      value={{
        states,
        connections,
        locks,
        sseConnected,
        getBoardState,
        getRelayState,
        isBoardConnected,
        getLockState,
        updateLocalState,
        updateLocalLock,
        checkConnections,
      }}
    >
      {children}
    </RelayStateContext.Provider>
  )
}

export function useRelayStateContext() {
  const context = useContext(RelayStateContext)
  if (!context) {
    throw new Error("useRelayStateContext must be used within RelayStateProvider")
  }
  return context
}
