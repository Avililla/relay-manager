import { EditorSkeleton } from "@/components/admin/editor-skeleton"

/** New user skeleton: Cuenta, Contraseña and Acceso panels; Equipos que verá. */
export default function Loading() {
  return <EditorSkeleton panels={[["half", "half", "half"], ["half", "half"], ["full", "half"]]} aside={[3]} />
}
