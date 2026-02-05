/**
 * Relay Manager
 *
 * @author Alejandro Avila Marcos
 * Made with ❤️ for dev team Valdepeñas
 */

"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"
import { Usb, Save, Check } from "lucide-react"
import { cn } from "@/lib/utils"
import { updateAllSerialPorts } from "@/actions/serial-ports"

interface SerialPort {
  id?: string
  boardIndex: number
  serialId: string | null
  label: string | null
  baudRate: number
}

interface SerialPortsConfigProps {
  equipmentId: string
  serialPortCount: number
  existingPorts: SerialPort[]
}

const BAUD_RATES = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600]

export function SerialPortsConfig({
  equipmentId,
  serialPortCount,
  existingPorts,
}: SerialPortsConfigProps) {
  // Inicializar con puertos existentes o crear placeholders
  const initialPorts: SerialPort[] = Array.from({ length: serialPortCount }, (_, i) => {
    const existing = existingPorts.find((p) => p.boardIndex === i)
    return existing || {
      boardIndex: i,
      serialId: null,
      label: null,
      baudRate: 115200,
    }
  })

  const [ports, setPorts] = useState<SerialPort[]>(initialPorts)
  const [loading, setLoading] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function updatePort(index: number, field: keyof SerialPort, value: string | number | null) {
    setPorts((prev) =>
      prev.map((p) =>
        p.boardIndex === index ? { ...p, [field]: value } : p
      )
    )
    setSaved(false)
  }

  async function handleSave() {
    setLoading(true)
    setError(null)
    setSaved(false)

    try {
      await updateAllSerialPorts(
        equipmentId,
        ports.map((p) => ({
          boardIndex: p.boardIndex,
          serialId: p.serialId || null,
          label: p.label || null,
          baudRate: p.baudRate,
        }))
      )
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al guardar")
    } finally {
      setLoading(false)
    }
  }

  if (serialPortCount === 0) {
    return null
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Usb className="h-5 w-5 text-muted-foreground" />
            <div>
              <CardTitle>Puertos Serial</CardTitle>
              <CardDescription>
                Configura los {serialPortCount} puertos serial de este equipo
              </CardDescription>
            </div>
          </div>
          <Button onClick={handleSave} disabled={loading}>
            {loading ? (
              "Guardando..."
            ) : saved ? (
              <>
                <Check className="mr-2 h-4 w-4" />
                Guardado
              </>
            ) : (
              <>
                <Save className="mr-2 h-4 w-4" />
                Guardar
              </>
            )}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {ports.map((port) => (
          <div
            key={port.boardIndex}
            className={cn(
              "p-4 rounded-lg border space-y-3",
              port.serialId ? "bg-green-500/5 border-green-500/20" : "bg-muted/50"
            )}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Badge variant={port.serialId ? "default" : "outline"}>
                  Placa {port.boardIndex + 1}
                </Badge>
                {port.serialId && (
                  <span className="text-xs text-green-600">Configurado</span>
                )}
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor={`label-${port.boardIndex}`}>Etiqueta</Label>
                <Input
                  id={`label-${port.boardIndex}`}
                  placeholder={`Placa ${port.boardIndex + 1}`}
                  value={port.label || ""}
                  onChange={(e) => updatePort(port.boardIndex, "label", e.target.value || null)}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor={`serialId-${port.boardIndex}`}>ID Serial (path)</Label>
                <Input
                  id={`serialId-${port.boardIndex}`}
                  placeholder="/dev/serial/by-id/usb-FTDI_..."
                  value={port.serialId || ""}
                  onChange={(e) => updatePort(port.boardIndex, "serialId", e.target.value || null)}
                  className="font-mono text-sm"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor={`baudRate-${port.boardIndex}`}>Baud Rate</Label>
                <Select
                  value={port.baudRate.toString()}
                  onValueChange={(value) => updatePort(port.boardIndex, "baudRate", parseInt(value))}
                >
                  <SelectTrigger id={`baudRate-${port.boardIndex}`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {BAUD_RATES.map((rate) => (
                      <SelectItem key={rate} value={rate.toString()}>
                        {rate.toLocaleString()}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
        ))}

        {error && <p className="text-sm text-destructive">{error}</p>}

        <p className="text-xs text-muted-foreground">
          Para obtener el ID serial en Linux, usa: <code className="bg-muted px-1 rounded">ls -la /dev/serial/by-id/</code>
        </p>
      </CardContent>
    </Card>
  )
}
