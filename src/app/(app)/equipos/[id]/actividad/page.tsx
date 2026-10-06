import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { PageMeta } from "@/components/shell/page-meta"
import { ActivityView } from "@/components/workspace/activity-view"
import { activity, banco, errorsText } from "@/lib/i18n/banco"
import { getEquipmentActivity } from "@/server/queries/equipment"
import { loadWorkspace } from "../workspace-data"

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params
  const { data } = await loadWorkspace(id)
  return { title: data ? activity.pageTitle(data.name) : errorsText.notFoundTitle }
}

/** Equipo "Actividad" tab (§8.9): first page on the server, "Cargar más" on the client. */
export default async function ActividadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { user, data } = await loadWorkspace(id)
  if (!data) notFound()
  const first = await getEquipmentActivity(user, id, null)
  return (
    <>
      <PageMeta breadcrumbs={[{ label: banco.title, href: "/" }, { label: data.name, href: `/equipos/${data.id}` }, { label: activity.title }]} />
      <ActivityView equipmentId={data.id} initial={first} showIp={user.isAdmin} />
    </>
  )
}
