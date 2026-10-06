import type { Metadata } from "next"
import { redirect } from "next/navigation"
import { TemplateEditor } from "@/components/templates/template-editor"
import { templateText as t } from "@/lib/i18n/wizard"
import { getAuthUser } from "@/server/authz"
import { listEquipmentCards } from "@/server/queries/equipment"
import { adminPageMetadata } from "../../_lib/admin-metadata"

export async function generateMetadata(): Promise<Metadata> {
  return adminPageMetadata(t.newTitle)
}

/** Nueva plantilla (§8.9, admin): the editor with one console and no relays. */
export default async function NuevaPlantillaPage() {
  const user = await getAuthUser()
  if (!user) redirect("/login")
  if (!user.isAdmin) redirect("/") // §6.2: non-admins go to the Banco, never to an error page
  const names = (await listEquipmentCards(user)).map((e) => e.name)
  return <TemplateEditor template={null} existingNames={names} />
}
