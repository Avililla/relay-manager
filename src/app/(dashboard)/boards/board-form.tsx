/**
 * Relay Manager
 *
 * @author Alejandro Avila Marcos
 * Made with ❤️ for dev team Valdepeñas
 */

"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { createBoard, updateBoard } from "@/actions/boards"

interface BoardFormProps {
  initialData?: {
    id: string
    name: string
    ipAddress: string
    totalRelays: number
  }
}

export function BoardForm({ initialData }: BoardFormProps) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isEditing = !!initialData

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setLoading(true)
    setError(null)

    const formData = new FormData(e.currentTarget)
    const data = {
      name: formData.get("name") as string,
      ipAddress: formData.get("ipAddress") as string,
      totalRelays: parseInt(formData.get("totalRelays") as string) || 8,
    }

    try {
      if (isEditing) {
        await updateBoard(initialData.id, data)
        router.push(`/boards/${initialData.id}`)
      } else {
        const board = await createBoard(data)
        router.push(`/boards/${board.id}`)
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
          <CardTitle>{isEditing ? "Editar Placa" : "Nueva Placa Devantech"}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name">Nombre</Label>
            <Input
              id="name"
              name="name"
              placeholder="Placa Lab 1"
              defaultValue={initialData?.name}
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="ipAddress">Dirección IP</Label>
            <Input
              id="ipAddress"
              name="ipAddress"
              placeholder="192.168.0.123"
              defaultValue={initialData?.ipAddress}
              required
            />
            <p className="text-xs text-muted-foreground">
              La placa debe ser accesible en http://IP/index.xml
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="totalRelays">Número de relés</Label>
            <Input
              id="totalRelays"
              name="totalRelays"
              type="number"
              min="1"
              max="32"
              defaultValue={initialData?.totalRelays ?? 8}
              required
            />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </CardContent>
        <CardFooter className="flex gap-2">
          <Button type="submit" disabled={loading}>
            {loading ? "Guardando..." : isEditing ? "Guardar cambios" : "Crear placa"}
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
