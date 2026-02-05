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
import { deleteRole } from "@/actions/roles"

interface DeleteRoleButtonProps {
  id: string
  name: string
  userCount: number
  equipmentCount: number
}

export function DeleteRoleButton({
  id,
  name,
  userCount,
  equipmentCount,
}: DeleteRoleButtonProps) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleDelete() {
    setLoading(true)
    setError(null)
    try {
      await deleteRole(id)
      router.push("/roles")
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
          <DialogTitle>Eliminar rol</DialogTitle>
          <DialogDescription>
            ¿Estás seguro de que quieres eliminar el rol &quot;{name}&quot;?
            {(userCount > 0 || equipmentCount > 0) && (
              <>
                {" "}Se eliminará de{" "}
                {userCount > 0 && `${userCount} usuario(s)`}
                {userCount > 0 && equipmentCount > 0 && " y "}
                {equipmentCount > 0 && `${equipmentCount} equipo(s)`}.
              </>
            )}
            {" "}Esta acción no se puede deshacer.
          </DialogDescription>
        </DialogHeader>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancelar
          </Button>
          <Button
            variant="destructive"
            onClick={handleDelete}
            disabled={loading}
          >
            {loading ? "Eliminando..." : "Eliminar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
