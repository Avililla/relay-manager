import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { PageMeta } from "@/components/shell/page-meta"
import { Workspace } from "@/components/workspace/workspace"
import { banco, errorsText } from "@/lib/i18n/banco"
import { loadWorkspace } from "./workspace-data"

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params
  const { data } = await loadWorkspace(id)
  return { title: data?.name ?? errorsText.notFoundTitle }
}

/** Equipo workspace, "Consolas" tab (§8.9). */
export default async function EquipoPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { data } = await loadWorkspace(id)
  if (!data) notFound()
  return (
    <>
      <PageMeta breadcrumbs={[{ label: banco.title, href: "/" }, { label: data.name }]} />
      <Workspace data={data} />
    </>
  )
}
