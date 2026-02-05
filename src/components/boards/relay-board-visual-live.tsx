/**
 * Relay Manager
 *
 * @author Alejandro Avila Marcos
 * Made with ❤️ for dev team Valdepeñas
 */

"use client"

import { useRelayStateContext } from "@/components/providers/relay-state-provider"
import { RelayBoardVisual } from "./relay-board-visual"
import { Badge } from "@/components/ui/badge"
import { Wifi, WifiOff } from "lucide-react"

interface Equipment {
  id: string
  name: string
  startRelay: number
  type: {
    name: string
    relayCount: number
    relayConfig: string
  }
}

interface RelayBoardVisualLiveProps {
  boardId: string
  totalRelays: number
  equipments: Equipment[]
  onRelayClick?: (relay: number, equipment?: Equipment) => void
}

export function RelayBoardVisualLive({
  boardId,
  totalRelays,
  equipments,
  onRelayClick,
}: RelayBoardVisualLiveProps) {
  const { getBoardState, isBoardConnected } = useRelayStateContext()

  const relayState = getBoardState(boardId)
  const isConnected = isBoardConnected(boardId)

  return (
    <div className="space-y-4">
      {/* Connection status */}
      <div className="flex items-center justify-end gap-2">
        {isConnected ? (
          <>
            <Wifi className="h-4 w-4 text-green-500" />
            <Badge variant="outline" className="text-green-500 border-green-500">
              Online
            </Badge>
          </>
        ) : (
          <>
            <WifiOff className="h-4 w-4 text-red-500" />
            <Badge variant="outline" className="text-red-500 border-red-500">
              Offline
            </Badge>
          </>
        )}
      </div>

      <RelayBoardVisual
        totalRelays={totalRelays}
        equipments={equipments}
        relayState={relayState}
        onRelayClick={onRelayClick}
      />
    </div>
  )
}
