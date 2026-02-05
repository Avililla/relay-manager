/**
 * Relay Manager
 *
 * @author Alejandro Avila Marcos
 * Made with ❤️ for dev team Valdepeñas
 */

"use client"

import { useState, useEffect, useCallback } from "react"
import Link from "next/link"
import { useSession } from "next-auth/react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { Settings, Cpu, Wifi, WifiOff, AlertTriangle, Lock, Unlock, User } from "lucide-react"
import { cn } from "@/lib/utils"
import { useRelayStateContext } from "@/components/providers/relay-state-provider"
import { lockEquipment, unlockEquipment, renewLock, forceUnlockEquipment } from "@/actions/equipment-lock"
import { LockExpirationWarning } from "./lock-expiration-warning"

interface EquipmentControlCardProps {
  equipment: {
    id: string
    name: string
    serialNumber: string | null
    startRelay: number
    type: {
      name: string
      relayCount: number
      relayConfig: string
    }
    board: {
      id: string
      name: string
      ipAddress: string
    }
    lockedById: string | null
    lockedBy: { id: string; email: string; name: string } | null
    lockExpiresAt: Date | null
  }
  settings: {
    lockTimeoutMins: number
    warningBeforeMins: number
  }
}

export function EquipmentControlCard({ equipment, settings }: EquipmentControlCardProps) {
  const { data: session } = useSession()
  const { getBoardState, updateLocalState, isBoardConnected, getLockState, updateLocalLock } = useRelayStateContext()
  const [loadingRelay, setLoadingRelay] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [lockLoading, setLockLoading] = useState(false)

  const relayState = getBoardState(equipment.board.id)
  const boardConnected = isBoardConnected(equipment.board.id)

  // Obtener estado de bloqueo desde SSE (o usar el inicial del server)
  const sseLockState = getLockState(equipment.id)
  const lockState = sseLockState || {
    lockedById: equipment.lockedById,
    lockedBy: equipment.lockedBy,
    lockExpiresAt: equipment.lockExpiresAt ? new Date(equipment.lockExpiresAt) : null,
  }

  const isAdmin = session?.user?.isAdmin ?? false
  const userId = session?.user?.id
  const isOwner = lockState.lockedById === userId
  const isLocked = lockState.lockedById !== null &&
                   lockState.lockExpiresAt !== null &&
                   lockState.lockExpiresAt > new Date()
  const canControl = !isLocked || isOwner || isAdmin

  // Verificar si el bloqueo ha expirado (actualización local)
  useEffect(() => {
    if (!lockState.lockExpiresAt) return

    const checkExpiration = () => {
      if (lockState.lockExpiresAt && lockState.lockExpiresAt <= new Date()) {
        updateLocalLock(equipment.id, {
          lockedById: null,
          lockedBy: null,
          lockExpiresAt: null,
        })
      }
    }

    const interval = setInterval(checkExpiration, 1000)
    return () => clearInterval(interval)
  }, [lockState.lockExpiresAt, equipment.id, updateLocalLock])

  // Parse relay labels
  let relayLabels: Array<{ label: string; purpose: string }> = []
  try {
    relayLabels = JSON.parse(equipment.type.relayConfig)
  } catch {
    relayLabels = Array.from(
      { length: equipment.type.relayCount },
      (_, i) => ({ label: `Rele ${i + 1}`, purpose: "unknown" })
    )
  }

  const handleRenewLock = useCallback(async () => {
    if (!isOwner) return
    try {
      const result = await renewLock(equipment.id)
      if (result.renewed && result.lockExpiresAt) {
        // La actualización vendrá via SSE, pero actualizamos localmente para UX inmediata
        updateLocalLock(equipment.id, {
          ...lockState,
          lockExpiresAt: new Date(result.lockExpiresAt),
        })
      }
    } catch {
      // Silently fail on renewal
    }
  }, [equipment.id, isOwner, lockState, updateLocalLock])

  async function handleToggleRelay(relayIndex: number) {
    if (loadingRelay !== null || !boardConnected || !canControl) return

    setLoadingRelay(relayIndex)
    setError(null)

    // Renovar bloqueo en cada interacción
    if (isOwner) {
      handleRenewLock()
    }

    // Actualización optimista
    updateLocalState(equipment.board.id, relayIndex)

    try {
      const response = await fetch("/api/relay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          boardId: equipment.board.id,
          relayIndex,
          equipmentId: equipment.id,
        }),
      })

      const data = await response.json()

      if (!response.ok) {
        updateLocalState(equipment.board.id, relayIndex)
        throw new Error(data.error || "Error al comunicar con la placa")
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error desconocido")
    } finally {
      setLoadingRelay(null)
    }
  }

  async function handleLock() {
    setLockLoading(true)
    setError(null)
    try {
      const result = await lockEquipment(equipment.id)
      // La actualización vendrá via SSE
      updateLocalLock(equipment.id, {
        lockedById: result.lockedBy?.id ?? null,
        lockedBy: result.lockedBy ?? null,
        lockExpiresAt: result.lockExpiresAt ? new Date(result.lockExpiresAt) : null,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al bloquear")
    } finally {
      setLockLoading(false)
    }
  }

  async function handleUnlock() {
    setLockLoading(true)
    setError(null)
    try {
      if (isAdmin && !isOwner) {
        await forceUnlockEquipment(equipment.id)
      } else {
        await unlockEquipment(equipment.id)
      }
      // La actualización vendrá via SSE
      updateLocalLock(equipment.id, {
        lockedById: null,
        lockedBy: null,
        lockExpiresAt: null,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al desbloquear")
    } finally {
      setLockLoading(false)
    }
  }

  // Check if any relay is on
  const anyRelayOn = Array.from({ length: equipment.type.relayCount }, (_, i) => {
    const relayIndex = equipment.startRelay - 1 + i
    return relayState[relayIndex] === "1"
  }).some(Boolean)

  // Count relays on
  const relaysOnCount = Array.from({ length: equipment.type.relayCount }, (_, i) => {
    const relayIndex = equipment.startRelay - 1 + i
    return relayState[relayIndex] === "1"
  }).filter(Boolean).length

  return (
    <Card className={cn(
      "transition-all duration-300 hover:shadow-lg w-[400px] shrink-0",
      !boardConnected && "opacity-75",
      boardConnected && anyRelayOn && "ring-2 ring-green-500/50 shadow-green-500/20 shadow-lg",
      isLocked && !canControl && "ring-2 ring-orange-500/50"
    )}>
      <CardHeader className="pb-4">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-3 min-w-0 flex-1">
            <div className={cn(
              "p-2.5 rounded-lg transition-colors shrink-0",
              !boardConnected
                ? "bg-red-500/20 text-red-500"
                : isLocked && !canControl
                  ? "bg-orange-500/20 text-orange-500"
                  : anyRelayOn
                    ? "bg-green-500/20 text-green-500"
                    : "bg-muted text-muted-foreground"
            )}>
              {!boardConnected ? (
                <AlertTriangle className="h-6 w-6" />
              ) : isLocked && !canControl ? (
                <Lock className="h-6 w-6" />
              ) : (
                <Cpu className="h-6 w-6" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <CardTitle className="text-xl truncate">{equipment.name}</CardTitle>
                <Badge variant="outline" className="text-xs shrink-0">
                  {equipment.type.name}
                </Badge>
              </div>
              {equipment.serialNumber && (
                <p className="text-xs text-muted-foreground font-mono mt-1 truncate">
                  S/N: {equipment.serialNumber}
                </p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {boardConnected ? (
              <div className="flex items-center gap-1.5">
                <Wifi className="h-4 w-4 text-green-500" />
                <span className="text-xs text-green-500 font-medium">Online</span>
              </div>
            ) : (
              <div className="flex items-center gap-1.5">
                <WifiOff className="h-4 w-4 text-red-500" />
                <span className="text-xs text-red-500 font-medium">Offline</span>
              </div>
            )}
            <Link href={`/equipments/${equipment.id}`}>
              <Button variant="ghost" size="icon" className="h-8 w-8">
                <Settings className="h-4 w-4" />
              </Button>
            </Link>
          </div>
        </div>

        {/* Status indicator */}
        <div className="flex items-center gap-2 mt-3">
          <div className={cn(
            "h-2 w-2 rounded-full",
            !boardConnected
              ? "bg-red-500"
              : anyRelayOn
                ? "bg-green-500 animate-pulse"
                : "bg-muted-foreground/30"
          )} />
          <span className="text-sm text-muted-foreground">
            {!boardConnected
              ? "Sin conexion con la placa"
              : `${relaysOnCount} de ${equipment.type.relayCount} activos`
            }
          </span>
        </div>

        {/* Lock status */}
        {isLocked && lockState.lockedBy && (
          <div className="flex items-center gap-2 mt-2 p-2 rounded-lg bg-orange-500/10 border border-orange-500/20">
            <User className="h-4 w-4 text-orange-500 shrink-0" />
            <span className="text-xs text-orange-600 truncate">
              Bloqueado por: {lockState.lockedBy.email}
            </span>
          </div>
        )}

        {/* Lock/Unlock button */}
        {boardConnected && (
          <div className="flex gap-2 mt-3">
            {!isLocked ? (
              <Button
                variant="outline"
                size="sm"
                onClick={handleLock}
                disabled={lockLoading}
                className="flex-1"
              >
                <Lock className="h-4 w-4 mr-2" />
                {lockLoading ? "Bloqueando..." : "Bloquear"}
              </Button>
            ) : (isOwner || isAdmin) ? (
              <Button
                variant="outline"
                size="sm"
                onClick={handleUnlock}
                disabled={lockLoading}
                className="flex-1"
              >
                <Unlock className="h-4 w-4 mr-2" />
                {lockLoading ? "Desbloqueando..." : isAdmin && !isOwner ? "Forzar desbloqueo" : "Desbloquear"}
              </Button>
            ) : null}
          </div>
        )}
      </CardHeader>

      <CardContent className="space-y-3">
        {/* Warning de expiración */}
        {isOwner && lockState.lockExpiresAt && (
          <LockExpirationWarning
            expiresAt={lockState.lockExpiresAt}
            warningBeforeMins={settings.warningBeforeMins}
            onRenew={handleRenewLock}
          />
        )}

        {/* Relay controls */}
        <div className={cn("space-y-2", (!boardConnected || !canControl) && "pointer-events-none")}>
          {Array.from({ length: equipment.type.relayCount }, (_, i) => {
            const relayIndex = equipment.startRelay - 1 + i
            const isOn = relayState[relayIndex] === "1"
            const isLoading = loadingRelay === relayIndex
            const labelInfo = relayLabels[i] || { label: `Rele ${i + 1}`, purpose: "unknown" }
            const disabled = isLoading || !boardConnected || !canControl

            return (
              <div
                key={relayIndex}
                className={cn(
                  "flex items-center justify-between p-3 rounded-lg border transition-all duration-200",
                  !boardConnected || !canControl
                    ? "bg-muted/30 border-transparent opacity-50"
                    : isOn
                      ? "bg-green-500/10 border-green-500/50"
                      : "bg-muted/50 border-transparent hover:border-muted-foreground/20"
                )}
              >
                <div className="flex items-center gap-3">
                  <div className={cn(
                    "h-2 w-2 rounded-full transition-colors",
                    !boardConnected || !canControl
                      ? "bg-muted-foreground/20"
                      : isOn
                        ? "bg-green-500"
                        : "bg-muted-foreground/30"
                  )} />
                  <span className={cn(
                    "font-medium text-sm",
                    !boardConnected || !canControl
                      ? "text-muted-foreground/50"
                      : isOn
                        ? "text-foreground"
                        : "text-muted-foreground"
                  )}>
                    {labelInfo.label}
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  <span className={cn(
                    "text-xs font-medium uppercase tracking-wider",
                    !boardConnected || !canControl
                      ? "text-muted-foreground/30"
                      : isOn
                        ? "text-green-500"
                        : "text-muted-foreground"
                  )}>
                    {isOn ? "ON" : "OFF"}
                  </span>
                  <Switch
                    checked={isOn}
                    onCheckedChange={() => handleToggleRelay(relayIndex)}
                    disabled={disabled}
                    className={cn(
                      "data-[state=checked]:bg-green-500",
                      disabled && "opacity-50 cursor-not-allowed"
                    )}
                  />
                </div>
              </div>
            )
          })}
        </div>

        {error && (
          <p className="text-xs text-destructive text-center py-2">{error}</p>
        )}

        {!boardConnected && (
          <p className="text-xs text-muted-foreground text-center py-2">
            Verifica que la placa este encendida y conectada a la red
          </p>
        )}

        {isLocked && !canControl && (
          <p className="text-xs text-orange-500 text-center py-2">
            Este equipo esta bloqueado. Solo {lockState.lockedBy?.email} o un administrador pueden controlarlo.
          </p>
        )}
      </CardContent>
    </Card>
  )
}
