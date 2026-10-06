import type { Metadata } from "next"
import { CablesView } from "@/components/accesses/cables-view"
import { cablesUi } from "@/lib/i18n/accesses"
import { getCablesPage } from "@/server/queries/accesses"
import { keptSearch, requireAdminPage } from "../placas/_lib/require-admin-page"

export const metadata: Metadata = { title: cablesUi.title }

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> }

/** Cables (admin): named JTAG cables and USB-serial adapters. `?tab=jtag|serie`. */
export default async function CablesPage({ searchParams }: Props) {
  const sp = await searchParams
  const user = await requireAdminPage(`/cables${keptSearch(sp, ["tab"])}`)
  return <CablesView data={await getCablesPage(user)} />
}
