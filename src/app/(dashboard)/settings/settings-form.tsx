/**
 * Relay Manager
 *
 * @author Alejandro Avila Marcos
 * Made with ❤️ for dev team Valdepeñas
 */

"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { updateSettings } from "@/actions/settings"
import { Lock, Clock, AlertTriangle } from "lucide-react"

interface SettingsFormProps {
  settings: {
    lockTimeoutMins: number
    warningBeforeMins: number
  }
}

export function SettingsForm({ settings }: SettingsFormProps) {
  const router = useRouter()
  const [lockTimeoutMins, setLockTimeoutMins] = useState(settings.lockTimeoutMins)
  const [warningBeforeMins, setWarningBeforeMins] = useState(settings.warningBeforeMins)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setIsLoading(true)
    setError(null)

    try {
      await updateSettings({
        lockTimeoutMins,
        warningBeforeMins,
      })
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al guardar")
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Lock className="h-5 w-5" />
            Sistema de Bloqueo de Equipos
          </CardTitle>
          <CardDescription>
            Configura el tiempo de bloqueo automatico de equipos y el aviso previo a la expiracion
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid gap-6 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="lockTimeout" className="flex items-center gap-2">
                <Clock className="h-4 w-4" />
                Tiempo de bloqueo (minutos)
              </Label>
              <Input
                id="lockTimeout"
                type="number"
                min={5}
                value={lockTimeoutMins}
                onChange={(e) => setLockTimeoutMins(parseInt(e.target.value) || 5)}
              />
              <p className="text-xs text-muted-foreground">
                Tiempo maximo que un usuario puede mantener bloqueado un equipo sin interactuar
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="warningBefore" className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4" />
                Aviso previo (minutos)
              </Label>
              <Input
                id="warningBefore"
                type="number"
                min={1}
                max={lockTimeoutMins - 1}
                value={warningBeforeMins}
                onChange={(e) => setWarningBeforeMins(parseInt(e.target.value) || 1)}
              />
              <p className="text-xs text-muted-foreground">
                Minutos antes de la expiracion para mostrar el aviso al usuario
              </p>
            </div>
          </div>

          <div className="bg-muted/50 rounded-lg p-4 space-y-2">
            <h4 className="font-medium text-sm">Como funciona el bloqueo:</h4>
            <ul className="text-sm text-muted-foreground space-y-1 list-disc list-inside">
              <li>Cuando un usuario bloquea un equipo, solo el y los administradores pueden controlarlo</li>
              <li>El bloqueo se renueva automaticamente cada vez que el usuario interactua con los reles</li>
              <li>Si no hay interaccion, se muestra un aviso {warningBeforeMins} minuto(s) antes de expirar</li>
              <li>Si el usuario no confirma, el bloqueo expira automaticamente a los {lockTimeoutMins} minutos</li>
              <li>Los administradores siempre pueden desbloquear cualquier equipo</li>
            </ul>
          </div>

          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}

          <div className="flex justify-end">
            <Button type="submit" disabled={isLoading}>
              {isLoading ? "Guardando..." : "Guardar Configuracion"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </form>
  )
}
