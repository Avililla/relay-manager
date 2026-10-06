import { EditorSkeleton } from "@/components/admin/editor-skeleton"

/** Role detail skeleton: the explanation, Rol and Miembros y equipos panels; Efecto and Acciones. */
export default function Loading() {
  return <EditorSkeleton summary lead panels={[["half", "full"], ["full", "full"]]} aside={[3, 1]} />
}
