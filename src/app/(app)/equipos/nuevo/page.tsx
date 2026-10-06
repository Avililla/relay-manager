import type { Metadata } from "next"
import { redirect } from "next/navigation"
import { NewEquipmentWizard } from "@/components/wizard/new-equipment-wizard"
import { wizardText as t } from "@/lib/i18n/wizard"
import { BLANK } from "@/lib/wizard/draft"
import { getAuthUser } from "@/server/authz"
import { getWizardData } from "@/server/queries/wizard"
import { adminPageMetadata } from "../../_lib/admin-metadata"

export async function generateMetadata(): Promise<Metadata> {
  return adminPageMetadata(t.pageTitle)
}

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> }

/**
 * Nuevo equipo (§8.9, admin). `?plantilla=<id>` (from Plantillas) preselects a template; otherwise the first one
 * (by position), so the common case is one click per step. Retired templates are never offered.
 */
export default async function NuevoEquipoPage({ searchParams }: Props) {
  const user = await getAuthUser()
  if (!user) redirect("/login")
  if (!user.isAdmin) redirect("/") // §6.2: non-admins go to the Banco, never to an error page
  const [data, sp] = await Promise.all([getWizardData(user), searchParams])
  const wanted = typeof sp.plantilla === "string" ? sp.plantilla : null
  const valid = (id: string | null) => !!id && (id === BLANK || data.templates.some((x) => x.id === id))
  const initial = valid(wanted) ? wanted : (data.templates[0]?.id ?? BLANK)
  return <NewEquipmentWizard data={data} initialChoice={initial} />
}
