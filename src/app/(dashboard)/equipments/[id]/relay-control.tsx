/**
 * Relay Manager
 *
 * @author Alejandro Avila Marcos
 * Made with ❤️ for dev team Valdepeñas
 */

"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { Power, Wifi, WifiOff, AlertTriangle } from "lucide-react"
import { cn } from "@/lib/utils"
import { useRelayStateContext } from "@/components/providers/relay-state-provider"

interface RelayControlProps {
  equipment: {
    id: string
    name: string
    startRelay: number
    relayCount: number
    relayLabels: Array<{ label: string; purpose: string }>
  }
  board: {
    id: string
    ipAddress: string
  }
}

export function RelayControl({ equipment, board }: RelayControlProps) {
  const { getBoardState, updateLocalState, isBoardConnected } = useRelayStateContext()
  const [loadingRelay, setLoadingRelay] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  const relayState = getBoardState(board.id)
  const boardConnected = isBoardConnected(board.id)

  async function handleToggleRelay(relayIndex: number) {
    if (loadingRelay !== null || !boardConnected) return

    setLoadingRelay(relayIndex)
    setError(null)

    // Actualización optimista
    updateLocalState(board.id, relayIndex)

    try {
      const response = await fetch("/api/relay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          boardId: board.id,
          relayIndex,
        }),
      })

      const data = await response.json()

      if (!response.ok) {
        updateLocalState(board.id, relayIndex)
        throw new Error(data.error || "Error al comunicar con la placa")
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error desconocido")
    } finally {
      setLoadingRelay(null)
    }
  }

  async function setAllRelays(state: boolean) {
    if (!boardConnected) return

    for (let i = 0; i < equipment.relayCount; i++) {
      const relayIndex = equipment.startRelay - 1 + i
      const currentState = relayState[relayIndex] === "1"
      if (currentState !== state) {
        await handleToggleRelay(relayIndex)
      }
    }
  }

  return (
    <div className="space-y-6">
      {/* Connection status banner */}
      {!boardConnected && (
        <div className="flex items-center gap-3 p-4 rounded-lg bg-red-500/10 border border-red-500/30">
          <AlertTriangle className="h-5 w-5 text-red-500" />
          <div>
            <p className="font-medium text-red-500">Sin conexión con la placa</p>
            <p className="text-sm text-muted-foreground">
              Verifica que la placa esté encendida y conectada a la red ({board.ipAddress})
            </p>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between">
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setAllRelays(true)}
            disabled={loadingRelay !== null || !boardConnected}
          >
            <Power className="mr-2 h-4 w-4" />
            Encender todos
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setAllRelays(false)}
            disabled={loadingRelay !== null || !boardConnected}
          >
            <Power className="mr-2 h-4 w-4" />
            Apagar todos
          </Button>
        </div>
        <div className="flex items-center gap-2">
          {boardConnected ? (
            <>
              <Wifi className="h-4 w-4 text-green-500" />
              <span className="text-sm text-green-500 font-medium">Online</span>
            </>
          ) : (
            <>
              <WifiOff className="h-4 w-4 text-red-500" />
              <span className="text-sm text-red-500 font-medium">Offline</span>
            </>
          )}
        </div>
      </div>

      <div className={cn(
        "grid gap-4 sm:grid-cols-2",
        !boardConnected && "pointer-events-none"
      )}>
        {Array.from({ length: equipment.relayCount }, (_, i) => {
          const relayIndex = equipment.startRelay - 1 + i
          const relayNumber = equipment.startRelay + i
          const isOn = relayState[relayIndex] === "1"
          const isLoading = loadingRelay === relayIndex
          const labelInfo = equipment.relayLabels[i] || { label: `Relé ${i + 1}`, purpose: "unknown" }

          return (
            <div
              key={relayNumber}
              className={cn(
                "p-4 rounded-xl border-2 transition-all duration-200",
                !boardConnected
                  ? "bg-muted/30 border-muted opacity-50"
                  : isOn
                    ? "bg-green-500/10 border-green-500"
                    : "bg-muted/50 border-transparent hover:border-muted-foreground/30"
              )}
            >
              <div className="flex items-center justify-between mb-3">
                <Badge variant="outline" className="text-xs">
                  Relé {relayNumber}
                </Badge>
                <Badge
                  variant={isOn ? "default" : "secondary"}
                  className={cn(
                    isOn && "bg-green-500 hover:bg-green-500"
                  )}
                >
                  {isOn ? "ON" : "OFF"}
                </Badge>
              </div>

              <p className={cn(
                "text-lg font-semibold mb-4",
                !boardConnected
                  ? "text-muted-foreground/50"
                  : isOn
                    ? "text-foreground"
                    : "text-muted-foreground"
              )}>
                {labelInfo.label}
              </p>

              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className={cn(
                    "h-3 w-3 rounded-full transition-colors",
                    !boardConnected
                      ? "bg-muted-foreground/20"
                      : isOn
                        ? "bg-green-500 animate-pulse"
                        : "bg-muted-foreground/30"
                  )} />
                  <span className={cn(
                    "text-sm",
                    !boardConnected
                      ? "text-muted-foreground/30"
                      : isOn
                        ? "text-green-500"
                        : "text-muted-foreground"
                  )}>
                    {isOn ? "Activo" : "Inactivo"}
                  </span>
                </div>
                <Switch
                  checked={isOn}
                  onCheckedChange={() => handleToggleRelay(relayIndex)}
                  disabled={isLoading || !boardConnected}
                  className={cn(
                    "scale-125 data-[state=checked]:bg-green-500",
                    (isLoading || !boardConnected) && "opacity-50 cursor-not-allowed"
                  )}
                />
              </div>
            </div>
          )
        })}
      </div>

      {error && (
        <p className="text-sm text-destructive text-center">{error}</p>
      )}
    </div>
  )
}
