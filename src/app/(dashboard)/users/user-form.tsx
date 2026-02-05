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
import { Checkbox } from "@/components/ui/checkbox"
import { Switch } from "@/components/ui/switch"
import { createUser, updateUser } from "@/actions/users"

interface UserFormProps {
  roles: Array<{ id: string; name: string }>
  initialData?: {
    id: string
    email: string
    name: string
    isAdmin: boolean
    roles: Array<{ id: string; name: string }>
  }
}

export function UserForm({ roles, initialData }: UserFormProps) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isAdmin, setIsAdmin] = useState(initialData?.isAdmin ?? false)
  const [selectedRoleIds, setSelectedRoleIds] = useState<string[]>(
    initialData?.roles.map((r) => r.id) ?? []
  )

  const isEditing = !!initialData

  function toggleRole(roleId: string) {
    setSelectedRoleIds((prev) =>
      prev.includes(roleId) ? prev.filter((id) => id !== roleId) : [...prev, roleId]
    )
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setLoading(true)
    setError(null)

    const formData = new FormData(e.currentTarget)

    const data = {
      email: formData.get("email") as string,
      name: formData.get("name") as string,
      isAdmin,
      roleIds: selectedRoleIds,
      password: formData.get("password") as string,
    }

    try {
      if (isEditing) {
        await updateUser(initialData.id, {
          ...data,
          password: data.password || undefined,
        })
        router.push(`/users/${initialData.id}`)
      } else {
        if (!data.password) {
          setError("La contraseña es requerida")
          setLoading(false)
          return
        }
        const user = await createUser(data)
        router.push(`/users/${user.id}`)
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
          <CardTitle>{isEditing ? "Editar Usuario" : "Nuevo Usuario"}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name">Nombre</Label>
            <Input
              id="name"
              name="name"
              placeholder="Juan García"
              defaultValue={initialData?.name}
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              name="email"
              type="email"
              placeholder="juan@ejemplo.com"
              defaultValue={initialData?.email}
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="password">
              {isEditing ? "Nueva Contraseña (dejar vacío para mantener)" : "Contraseña"}
            </Label>
            <Input
              id="password"
              name="password"
              type="password"
              placeholder="••••••••"
              required={!isEditing}
            />
          </div>

          <div className="flex items-center justify-between rounded-lg border p-4">
            <div className="space-y-0.5">
              <Label htmlFor="isAdmin">Administrador</Label>
              <p className="text-sm text-muted-foreground">
                Los administradores pueden gestionar todos los recursos
              </p>
            </div>
            <Switch
              id="isAdmin"
              checked={isAdmin}
              onCheckedChange={setIsAdmin}
            />
          </div>

          <div className="space-y-2">
            <Label>Roles</Label>
            <p className="text-xs text-muted-foreground mb-2">
              Los roles determinan qué equipos puede ver el usuario. Sin roles = solo ve equipos públicos.
            </p>
            <div className="grid gap-2">
              {roles.length === 0 ? (
                <p className="text-sm text-muted-foreground">No hay roles disponibles</p>
              ) : (
                roles.map((role) => (
                  <div
                    key={role.id}
                    className="flex items-center space-x-3 rounded-lg border p-3"
                  >
                    <Checkbox
                      id={`role-${role.id}`}
                      checked={selectedRoleIds.includes(role.id)}
                      onCheckedChange={() => toggleRole(role.id)}
                    />
                    <Label
                      htmlFor={`role-${role.id}`}
                      className="flex-1 cursor-pointer font-normal"
                    >
                      {role.name}
                    </Label>
                  </div>
                ))
              )}
            </div>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </CardContent>
        <CardFooter className="flex gap-2">
          <Button type="submit" disabled={loading}>
            {loading ? "Guardando..." : isEditing ? "Guardar cambios" : "Crear usuario"}
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
