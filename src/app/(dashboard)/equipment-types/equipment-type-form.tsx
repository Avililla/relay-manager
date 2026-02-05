/**
 * Relay Manager
 *
 * @author Alejandro Avila Marcos
 * Made with ❤️ for dev team Valdepeñas
 */

"use client"

import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { createEquipmentType, updateEquipmentType } from "@/actions/equipment-types"
import { Plus, Minus } from "lucide-react"

interface RelayLabel {
  index: number
  purpose: string
  label: string
}

interface EquipmentTypeFormProps {
  initialData?: {
    id: string
    name: string
    description: string | null
    relayCount: number
    relayConfig: string
    serialPortCount: number
  }
}

export function EquipmentTypeForm({ initialData }: EquipmentTypeFormProps) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [relayCount, setRelayCount] = useState(initialData?.relayCount ?? 1)
  const [serialPortCount, setSerialPortCount] = useState(initialData?.serialPortCount ?? 0)
  const [relayLabels, setRelayLabels] = useState<RelayLabel[]>([])

  const isEditing = !!initialData

  // Initialize relay labels from initial data or create defaults
  // First relay is always ON/OFF (power)
  useEffect(() => {
    if (initialData?.relayConfig) {
      try {
        const parsed = JSON.parse(initialData.relayConfig)
        if (Array.isArray(parsed)) {
          setRelayLabels(parsed.map((item, i) => ({
            index: i,
            purpose: i === 0 ? "power" : (item.purpose || "mode"),
            label: i === 0 ? "ON/OFF" : (item.label || `Relé ${i + 1}`),
          })))
          return
        }
      } catch {
        // Fall through to default
      }
    }

    // Create default labels based on relay count
    // First relay is always ON/OFF
    setRelayLabels(
      Array.from({ length: relayCount }, (_, i) => ({
        index: i,
        purpose: i === 0 ? "power" : "mode",
        label: i === 0 ? "ON/OFF" : `Relé ${i + 1}`,
      }))
    )
  }, [])

  // Update labels when relay count changes
  useEffect(() => {
    setRelayLabels((prev) => {
      if (prev.length < relayCount) {
        // Add new labels (new relays are "mode" type)
        return [
          ...prev,
          ...Array.from({ length: relayCount - prev.length }, (_, i) => ({
            index: prev.length + i,
            purpose: "mode",
            label: `Relé ${prev.length + i + 1}`,
          })),
        ]
      } else if (prev.length > relayCount) {
        // Remove labels but keep at least relay 0 (ON/OFF)
        return prev.slice(0, Math.max(1, relayCount))
      }
      return prev
    })
  }, [relayCount])

  function updateLabel(index: number, label: string) {
    setRelayLabels((prev) =>
      prev.map((item, i) => (i === index ? { ...item, label } : item))
    )
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setLoading(true)
    setError(null)

    const formData = new FormData(e.currentTarget)

    const data = {
      name: formData.get("name") as string,
      description: (formData.get("description") as string) || null,
      relayCount,
      relayConfig: JSON.stringify(relayLabels),
      serialPortCount,
    }

    try {
      if (isEditing) {
        await updateEquipmentType(initialData.id, data)
        router.push(`/equipment-types/${initialData.id}`)
      } else {
        const equipmentType = await createEquipmentType(data)
        router.push(`/equipment-types/${equipmentType.id}`)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al guardar")
      setLoading(false)
    }
  }

  return (
    <Card className="max-w-2xl">
      <form onSubmit={handleSubmit}>
        <CardHeader>
          <CardTitle>{isEditing ? "Editar Tipo de Equipo" : "Nuevo Tipo de Equipo"}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-2">
            <Label htmlFor="name">Nombre</Label>
            <Input
              id="name"
              name="name"
              placeholder="Tipo de equipo"
              defaultValue={initialData?.name}
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="description">Descripción</Label>
            <Textarea
              id="description"
              name="description"
              placeholder="Descripción del tipo de equipo..."
              defaultValue={initialData?.description || ""}
              rows={2}
            />
          </div>

          <div className="grid gap-6 md:grid-cols-2">
            <div className="space-y-2">
              <Label>Número de Relés</Label>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={() => setRelayCount((c) => Math.max(1, c - 1))}
                  disabled={relayCount <= 1}
                >
                  <Minus className="h-4 w-4" />
                </Button>
                <span className="w-12 text-center font-medium text-lg">{relayCount}</span>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={() => setRelayCount((c) => Math.min(16, c + 1))}
                  disabled={relayCount >= 16}
                >
                  <Plus className="h-4 w-4" />
                </Button>
              </div>
            </div>

            <div className="space-y-2">
              <Label>Puertos Serial (Placas Zynq)</Label>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={() => setSerialPortCount((c) => Math.max(0, c - 1))}
                  disabled={serialPortCount <= 0}
                >
                  <Minus className="h-4 w-4" />
                </Button>
                <span className="w-12 text-center font-medium text-lg">{serialPortCount}</span>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={() => setSerialPortCount((c) => Math.min(8, c + 1))}
                  disabled={serialPortCount >= 8}
                >
                  <Plus className="h-4 w-4" />
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Número de placas Zynq con consola serial
              </p>
            </div>
          </div>

          <div className="space-y-3">
            <Label>Configuración de Relés</Label>
            <div className="space-y-2">
              {relayLabels.map((relay, index) => (
                <div key={index} className="flex items-center gap-3">
                  <span className="text-sm text-muted-foreground w-16">
                    Relé {index + 1}
                  </span>
                  {index === 0 ? (
                    <div className="flex-1 flex items-center gap-2">
                      <Input
                        value="ON/OFF"
                        disabled
                        className="flex-1 bg-muted"
                      />
                      <span className="text-xs text-muted-foreground whitespace-nowrap">
                        (Encendido/Apagado)
                      </span>
                    </div>
                  ) : (
                    <Input
                      value={relay.label}
                      onChange={(e) => updateLabel(index, e.target.value)}
                      placeholder={`Etiqueta para relé ${index + 1}`}
                      className="flex-1"
                    />
                  )}
                </div>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              El primer relé siempre es ON/OFF. Los demás son configurables (ej: Modo A, Modo B, Reset)
            </p>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </CardContent>
        <CardFooter className="flex gap-2">
          <Button type="submit" disabled={loading}>
            {loading ? "Guardando..." : isEditing ? "Guardar cambios" : "Crear tipo"}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => router.back()}
          >
            Cancelar
          </Button>
        </CardFooter>
      </form>
    </Card>
  )
}
