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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Trash2 } from "lucide-react"
import { deleteEquipmentType } from "@/actions/equipment-types"

interface DeleteEquipmentTypeButtonProps {
  id: string
  name: string
  equipmentCount: number
}

export function DeleteEquipmentTypeButton({
  id,
  name,
  equipmentCount,
}: DeleteEquipmentTypeButtonProps) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const canDelete = equipmentCount === 0

  async function handleDelete() {
    setLoading(true)
    setError(null)
    try {
      await deleteEquipmentType(id)
      router.push("/equipment-types")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al eliminar")
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="destructive">
          <Trash2 className="mr-2 h-4 w-4" />
          Eliminar
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Eliminar tipo de equipo</DialogTitle>
          <DialogDescription>
            {canDelete ? (
              <>
                ¿Estás seguro de que quieres eliminar el tipo &quot;{name}&quot;?
                Esta acción no se puede deshacer.
              </>
            ) : (
              <>
                No se puede eliminar el tipo &quot;{name}&quot; porque hay{" "}
                {equipmentCount} equipo(s) usándolo. Elimina esos equipos primero.
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            {canDelete ? "Cancelar" : "Cerrar"}
          </Button>
          {canDelete && (
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={loading}
            >
              {loading ? "Eliminando..." : "Eliminar"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
