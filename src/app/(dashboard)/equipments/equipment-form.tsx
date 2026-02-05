/**
 * Relay Manager
 *
 * @author Alejandro Avila Marcos
 * Made with ❤️ for dev team Valdepeñas
 */

"use client"

import { useState, useEffect } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { createEquipment, updateEquipment, findAvailableSlots } from "@/actions/equipments"

interface EquipmentFormProps {
  boards: Array<{
    id: string
    name: string
    totalRelays: number
    availableRelays: number
    hasSpaceFor: number
  }>
  equipmentTypes: Array<{
    id: string
    name: string
    relayCount: number
  }>
  roles: Array<{
    id: string
    name: string
  }>
  initialData?: {
    id: string
    name: string
    description: string | null
    serialNumber: string | null
    typeId: string
    boardId: string
    startRelay: number
    relayCount: number
    roles: Array<{ id: string; name: string }>
  }
}

export function EquipmentForm({ boards, equipmentTypes, roles, initialData }: EquipmentFormProps) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedBoardId, setSelectedBoardId] = useState(
    initialData?.boardId || searchParams.get("boardId") || ""
  )
  const [selectedTypeId, setSelectedTypeId] = useState(initialData?.typeId || "")
  const [selectedRoleIds, setSelectedRoleIds] = useState<string[]>(
    initialData?.roles.map((r) => r.id) ?? []
  )
  const [availableSlots, setAvailableSlots] = useState<number[]>([])
  const [selectedSlot, setSelectedSlot] = useState<string>(
    initialData?.startRelay?.toString() || ""
  )

  const isEditing = !!initialData

  // Get selected type's relay count
  const selectedType = equipmentTypes.find((t) => t.id === selectedTypeId)
  const relayCount = selectedType?.relayCount || 0

  function toggleRole(roleId: string) {
    setSelectedRoleIds((prev) =>
      prev.includes(roleId) ? prev.filter((id) => id !== roleId) : [...prev, roleId]
    )
  }

  // Fetch available slots when board or type changes
  useEffect(() => {
    async function fetchSlots() {
      if (selectedBoardId && relayCount > 0) {
        try {
          const slots = await findAvailableSlots(selectedBoardId, relayCount)
          // If editing, add current slot if not already included
          if (isEditing && !slots.includes(initialData.startRelay)) {
            slots.unshift(initialData.startRelay)
            slots.sort((a, b) => a - b)
          }
          setAvailableSlots(slots)
          // Auto-select first available slot if not editing
          if (!isEditing && slots.length > 0 && !selectedSlot) {
            setSelectedSlot(slots[0].toString())
          }
        } catch {
          setAvailableSlots([])
        }
      } else {
        setAvailableSlots([])
      }
    }
    fetchSlots()
  }, [selectedBoardId, relayCount, isEditing, initialData?.startRelay])

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setLoading(true)
    setError(null)

    const formData = new FormData(e.currentTarget)
    const name = formData.get("name") as string
    const description = (formData.get("description") as string) || null
    const serialNumber = (formData.get("serialNumber") as string) || null

    try {
      if (isEditing) {
        await updateEquipment(initialData.id, {
          name,
          description,
          serialNumber,
          roleIds: selectedRoleIds,
          startRelay: parseInt(selectedSlot),
        })
        router.push(`/equipments/${initialData.id}`)
      } else {
        const equipment = await createEquipment({
          name,
          description,
          serialNumber,
          typeId: selectedTypeId,
          boardId: selectedBoardId,
          roleIds: selectedRoleIds,
          startRelay: parseInt(selectedSlot),
        })
        router.push(`/equipments/${equipment.id}`)
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
          <CardTitle>{isEditing ? "Editar Equipo" : "Nuevo Equipo"}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name">Nombre</Label>
            <Input
              id="name"
              name="name"
              placeholder="Equipo Lab 1"
              defaultValue={initialData?.name}
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="serialNumber">Número de Serie (S/N)</Label>
            <Input
              id="serialNumber"
              name="serialNumber"
              placeholder="SN-123456"
              defaultValue={initialData?.serialNumber || ""}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="description">Descripción (opcional)</Label>
            <Textarea
              id="description"
              name="description"
              placeholder="Descripción del equipo..."
              defaultValue={initialData?.description || ""}
              rows={2}
            />
          </div>

          {!isEditing && (
            <>
              <div className="space-y-2">
                <Label htmlFor="typeId">Tipo de Equipo</Label>
                <Select
                  name="typeId"
                  value={selectedTypeId}
                  onValueChange={(value) => {
                    setSelectedTypeId(value)
                    setSelectedBoardId("")
                    setSelectedSlot("")
                  }}
                  required
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Selecciona un tipo" />
                  </SelectTrigger>
                  <SelectContent>
                    {equipmentTypes.map((type) => (
                      <SelectItem key={type.id} value={type.id}>
                        {type.name} ({type.relayCount} relé{type.relayCount > 1 ? "s" : ""})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="boardId">Placa</Label>
                {!selectedTypeId ? (
                  <p className="text-sm text-muted-foreground">
                    Selecciona primero un tipo de equipo
                  </p>
                ) : (
                  <>
                    <Select
                      name="boardId"
                      value={selectedBoardId}
                      onValueChange={(value) => {
                        setSelectedBoardId(value)
                        setSelectedSlot("")
                      }}
                      required
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Selecciona una placa" />
                      </SelectTrigger>
                      <SelectContent>
                        {boards
                          .filter((board) => board.hasSpaceFor >= relayCount)
                          .map((board) => (
                            <SelectItem key={board.id} value={board.id}>
                              {board.name} ({board.availableRelays}/{board.totalRelays} disponibles)
                            </SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                    {boards.filter((board) => board.hasSpaceFor >= relayCount).length === 0 && (
                      <p className="text-sm text-destructive">
                        No hay placas con espacio suficiente para {relayCount} relé{relayCount > 1 ? "s" : ""} contiguos
                      </p>
                    )}
                  </>
                )}
              </div>
            </>
          )}

          {isEditing && (
            <div className="space-y-2">
              <Label>Tipo de Equipo</Label>
              <p className="text-sm text-muted-foreground">
                {equipmentTypes.find((t) => t.id === initialData.typeId)?.name} (
                {initialData.relayCount} relés)
              </p>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="startRelay">Relé Inicial</Label>
            {availableSlots.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {selectedBoardId && selectedTypeId
                  ? "No hay espacio disponible para este tipo de equipo"
                  : "Selecciona placa y tipo para ver posiciones disponibles"}
              </p>
            ) : (
              <>
                <Select
                  name="startRelay"
                  value={selectedSlot}
                  onValueChange={setSelectedSlot}
                  required
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Selecciona posición" />
                  </SelectTrigger>
                  <SelectContent>
                    {availableSlots.map((slot) => (
                      <SelectItem key={slot} value={slot.toString()}>
                        Relé {slot} - {slot + relayCount - 1}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div className="flex flex-wrap gap-2 mt-2">
                  {availableSlots.map((slot) => (
                    <Badge
                      key={slot}
                      variant={selectedSlot === slot.toString() ? "default" : "outline"}
                      className="cursor-pointer"
                      onClick={() => setSelectedSlot(slot.toString())}
                    >
                      {slot}-{slot + relayCount - 1}
                    </Badge>
                  ))}
                </div>
              </>
            )}
          </div>

          <div className="space-y-2">
            <Label>Visibilidad por Roles</Label>
            <p className="text-xs text-muted-foreground mb-2">
              Sin roles seleccionados = visible para todos los usuarios.
              Con roles = solo visible para usuarios con esos roles.
            </p>
            <div className="grid gap-2">
              {roles.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No hay roles disponibles. El equipo será visible para todos.
                </p>
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
            {selectedRoleIds.length === 0 && roles.length > 0 && (
              <p className="text-xs text-green-600 mt-1">
                Este equipo será visible para todos los usuarios.
              </p>
            )}
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </CardContent>
        <CardFooter className="flex gap-2">
          <Button
            type="submit"
            disabled={loading || availableSlots.length === 0}
          >
            {loading ? "Guardando..." : isEditing ? "Guardar cambios" : "Crear equipo"}
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
