/**
 * Relay Manager
 *
 * @author Alejandro Avila Marcos
 * Made with ❤️ for dev team Valdepeñas
 */

"use client"

import { cn } from "@/lib/utils"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

interface RelayConfig {
  index: number
  purpose: string
  label: string
}

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

interface RelayBoardVisualProps {
  totalRelays: number
  equipments: Equipment[]
  relayState?: string // "00000000" - estado de cada relé
  onRelayClick?: (relay: number, equipment?: Equipment) => void
}

const COLORS = [
  "bg-blue-500",
  "bg-green-500",
  "bg-yellow-500",
  "bg-purple-500",
  "bg-pink-500",
  "bg-orange-500",
  "bg-cyan-500",
  "bg-red-500",
]

export function RelayBoardVisual({
  totalRelays,
  equipments,
  relayState = "0".repeat(totalRelays),
  onRelayClick,
}: RelayBoardVisualProps) {
  // Crear mapa de ocupación de relés
  const relayMap = new Map<number, { equipment: Equipment; config: RelayConfig }>()

  equipments.forEach((equipment) => {
    let configs: RelayConfig[] = []
    try {
      configs = JSON.parse(equipment.type.relayConfig)
    } catch {
      configs = []
    }
    for (let i = 0; i < equipment.type.relayCount; i++) {
      const relayNumber = equipment.startRelay + i
      relayMap.set(relayNumber, {
        equipment,
        config: configs[i] || { index: i, purpose: "unknown", label: `Relé ${i + 1}` },
      })
    }
  })

  // Obtener color para un equipo
  const getEquipmentColor = (equipmentId: string) => {
    const index = equipments.findIndex((e) => e.id === equipmentId)
    return COLORS[index % COLORS.length]
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-8 gap-2">
        {Array.from({ length: totalRelays }, (_, i) => {
          const relayNumber = i + 1
          const relayIndex = i
          const occupancy = relayMap.get(relayNumber)
          const isOccupied = !!occupancy
          const isOn = relayState[relayIndex] === "1"

          // Color basado en si está ocupado y encendido
          let bgColor = "bg-muted"
          if (isOccupied) {
            bgColor = isOn
              ? getEquipmentColor(occupancy.equipment.id)
              : `${getEquipmentColor(occupancy.equipment.id)}/30`
          } else if (isOn) {
            bgColor = "bg-green-500"
          }

          return (
            <Tooltip key={relayNumber}>
              <TooltipTrigger asChild>
                <button
                  onClick={() =>
                    onRelayClick?.(relayNumber, occupancy?.equipment)
                  }
                  className={cn(
                    "aspect-square rounded-lg border-2 flex flex-col items-center justify-center transition-all hover:scale-105",
                    isOccupied ? "border-foreground/20" : "border-dashed border-muted-foreground/30",
                    bgColor,
                    isOccupied && isOn ? "text-white" : "text-muted-foreground",
                    isOn && "ring-2 ring-green-400"
                  )}
                >
                  <span className="text-lg font-bold">{relayNumber}</span>
                  {isOccupied && (
                    <span className="text-[10px] truncate max-w-full px-1">
                      {occupancy.equipment.name.slice(0, 6)}
                    </span>
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent>
                {isOccupied ? (
                  <div className="text-sm">
                    <p className="font-semibold">{occupancy.equipment.name}</p>
                    <p className="text-muted-foreground">
                      {occupancy.equipment.type.name}
                    </p>
                    <p className="text-xs mt-1">{occupancy.config.label}</p>
                    <p className={cn("text-xs font-semibold", isOn ? "text-green-500" : "text-red-500")}>
                      {isOn ? "ENCENDIDO" : "APAGADO"}
                    </p>
                  </div>
                ) : (
                  <div>
                    <p>Relé {relayNumber} - Disponible</p>
                    <p className={cn("text-xs font-semibold", isOn ? "text-green-500" : "text-red-500")}>
                      {isOn ? "ENCENDIDO" : "APAGADO"}
                    </p>
                  </div>
                )}
              </TooltipContent>
            </Tooltip>
          )
        })}
      </div>

      {/* Leyenda */}
      {equipments.length > 0 && (
        <div className="flex flex-wrap gap-2 pt-2 border-t">
          {equipments.map((equipment, index) => (
            <div
              key={equipment.id}
              className="flex items-center gap-2 text-sm"
            >
              <div
                className={cn(
                  "w-3 h-3 rounded",
                  COLORS[index % COLORS.length]
                )}
              />
              <span>
                {equipment.name} ({equipment.type.name})
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
