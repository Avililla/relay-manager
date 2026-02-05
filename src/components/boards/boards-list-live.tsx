/**
 * Relay Manager
 *
 * @author Alejandro Avila Marcos
 * Made with ❤️ for dev team Valdepeñas
 */

"use client"

import Link from "next/link"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { RelayBoardVisual } from "./relay-board-visual"
import { useRelayStateContext } from "@/components/providers/relay-state-provider"
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

interface Board {
  id: string
  name: string
  ipAddress: string
  totalRelays: number
  equipments: Equipment[]
}

interface BoardsListLiveProps {
  boards: Board[]
}

function BoardCardLive({ board }: { board: Board }) {
  const { getBoardState, isBoardConnected } = useRelayStateContext()
  const relayState = getBoardState(board.id)
  const isConnected = isBoardConnected(board.id)

  return (
    <Link href={`/boards/${board.id}`}>
      <Card className="hover:border-primary transition-colors cursor-pointer h-full">
        <CardHeader>
          <div className="flex items-start justify-between">
            <div>
              <CardTitle>{board.name}</CardTitle>
              <CardDescription>{board.ipAddress}</CardDescription>
            </div>
            <div className="flex items-center gap-2">
              {isConnected ? (
                <Wifi className="h-4 w-4 text-green-500" />
              ) : (
                <WifiOff className="h-4 w-4 text-red-500" />
              )}
              <Badge variant="outline">{board.totalRelays} reles</Badge>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <RelayBoardVisual
            totalRelays={board.totalRelays}
            equipments={board.equipments}
            relayState={relayState}
          />
          <p className="text-sm text-muted-foreground mt-4">
            {board.equipments.length} equipo(s) asignado(s)
          </p>
        </CardContent>
      </Card>
    </Link>
  )
}

export function BoardsListLive({ boards }: BoardsListLiveProps) {
  return (
    <div className="max-h-[70vh] overflow-auto custom-scrollbar pr-2">
      <div className="grid gap-6 md:grid-cols-2">
        {boards.map((board) => (
          <BoardCardLive key={board.id} board={board} />
        ))}
      </div>
    </div>
  )
}
