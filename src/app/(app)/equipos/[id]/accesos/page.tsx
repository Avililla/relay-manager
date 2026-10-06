import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { AccessesPanel } from "@/components/accesses/accesses-panel"
import { PageMeta } from "@/components/shell/page-meta"
import { banco, errorsText } from "@/lib/i18n/banco"
import { accessUi } from "@/lib/i18n/accesses"
import { loadWorkspace } from "../workspace-data"

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params
  const { data } = await loadWorkspace(id)
  return { title: data ? `${accessUi.tab} · ${data.name}` : errorsText.notFoundTitle }
}

/** Equipo workspace, "Accesos" tab: the network accesses of the unit (JTAG, serial over TCP, Ethernet). */
export default async function EquipoAccesosPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { data } = await loadWorkspace(id)
  if (!data) notFound()
  return (
    <>
      <PageMeta breadcrumbs={[{ label: banco.title, href: "/" }, { label: data.name, href: `/equipos/${data.id}` }, { label: accessUi.tab }]} />
      <AccessesPanel equipmentId={data.id} accesses={data.accesses} />
    </>
  )
}
