import type { Metadata } from "next"
import { notFound, redirect } from "next/navigation"
import { EquipmentSettingsForm } from "@/components/equipment-settings/equipment-settings-form"
import { IdSchema } from "@/lib/contracts/common"
import { errorsText } from "@/lib/i18n/banco"
import { settingsText as t } from "@/lib/i18n/wizard"
import { getAuthUser } from "@/server/authz"
import { getEquipmentEdit } from "@/server/queries/equipment"

type Props = { params: Promise<{ id: string }> }

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params
  const user = await getAuthUser()
  if (!IdSchema.safeParse(id).success) return { title: errorsText.notFoundTitle }
  if (!user?.isAdmin) return { title: t.breadcrumb }
  const data = await getEquipmentEdit(user, id)
  // An unknown or invisible unit is the segment's 404: its tab says so.
  return { title: data ? t.pageTitle(data.name) : errorsText.notFoundTitle }
}

/** Equipo "Ajustes" (§8.9, admin). Non-admins go back to the workspace; an unknown id is a 404. */
export default async function AjustesPage({ params }: Props) {
  const { id } = await params
  const user = await getAuthUser()
  if (!user) redirect("/login")
  if (!IdSchema.safeParse(id).success) notFound()
  if (!user.isAdmin) redirect(`/equipos/${id}`)
  const data = await getEquipmentEdit(user, id)
  if (!data) notFound()
  return <EquipmentSettingsForm data={data} />
}
