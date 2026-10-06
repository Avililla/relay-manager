import { EditorSkeleton } from "@/components/admin/editor-skeleton"

/** User detail skeleton: Cuenta and Acceso panels; Equipos que verá, Estado de la cuenta and Acciones. */
export default function Loading() {
  return <EditorSkeleton summary panels={[["half", "half", "half"], ["full", "half"]]} aside={[1, 4, 3]} />
}
