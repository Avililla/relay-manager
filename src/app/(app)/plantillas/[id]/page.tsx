import type { Metadata } from "next"
import { notFound, redirect } from "next/navigation"
import { TemplateEditor } from "@/components/templates/template-editor"
import { IdSchema } from "@/lib/contracts/common"
import { pages } from "@/lib/i18n/shell"
import { templateText as t } from "@/lib/i18n/wizard"
import { getAuthUser } from "@/server/authz"
import { listEquipmentCards } from "@/server/queries/equipment"
import { getTemplate } from "@/server/queries/templates"

type Props = { params: Promise<{ id: string }> }

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params
  const user = await getAuthUser()
  // Every case the page answers with a 404 (non-admin, bad or unknown id) gets the 404 title.
  if (!user?.isAdmin || !IdSchema.safeParse(id).success) return { title: pages.notFoundTitle }
  const tpl = await getTemplate(id)
  return { title: tpl ? t.editorTitle(tpl.name) : pages.notFoundTitle }
}

/** Template editor (§8.9, admin). An unknown id is a 404. */
export default async function PlantillaPage({ params }: Props) {
  const { id } = await params
  const user = await getAuthUser()
  if (!user) redirect("/login")
  if (!user.isAdmin) redirect("/") // §6.2: non-admins go to the Banco, never to an error page
  if (!IdSchema.safeParse(id).success) notFound()
  const [template, cards] = await Promise.all([getTemplate(id), listEquipmentCards(user)])
  if (!template) notFound()
  return <TemplateEditor template={template} existingNames={cards.map((e) => e.name)} />
}
