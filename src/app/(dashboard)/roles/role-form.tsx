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
import { Textarea } from "@/components/ui/textarea"
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { createRole, updateRole } from "@/actions/roles"

interface RoleFormProps {
  initialData?: {
    id: string
    name: string
    description: string | null
  }
}

export function RoleForm({ initialData }: RoleFormProps) {
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
      description: (formData.get("description") as string) || null,
    }

    try {
      if (isEditing) {
        await updateRole(initialData.id, data)
        router.push(`/roles/${initialData.id}`)
      } else {
        const role = await createRole(data)
        router.push(`/roles/${role.id}`)
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
          <CardTitle>{isEditing ? "Editar Rol" : "Nuevo Rol"}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name">Nombre</Label>
            <Input
              id="name"
              name="name"
              placeholder="Laboratorio"
              defaultValue={initialData?.name}
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="description">Descripción</Label>
            <Textarea
              id="description"
              name="description"
              placeholder="Describe el propósito de este rol..."
              defaultValue={initialData?.description || ""}
              rows={3}
            />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </CardContent>
        <CardFooter className="flex gap-2">
          <Button type="submit" disabled={loading}>
            {loading ? "Guardando..." : isEditing ? "Guardar cambios" : "Crear rol"}
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
