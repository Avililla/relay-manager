import { EditorSkeleton } from "@/components/admin/editor-skeleton"

/** New role skeleton: the explanation, Rol and Miembros y equipos panels; Efecto. */
export default function Loading() {
  return <EditorSkeleton lead panels={[["half", "full"], ["full", "full"]]} aside={[3]} />
}
