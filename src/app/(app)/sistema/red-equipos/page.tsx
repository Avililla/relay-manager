import type { Metadata } from "next"
import { EquipnetView } from "@/components/equipnet/equipnet-view"
import { system as t } from "@/lib/i18n/admin"
import { getEquipnetPage } from "@/server/queries/equipnet"
import { adminPage } from "../_lib/guard"

export const metadata: Metadata = { title: `${t.tabs.redEquipos} · ${t.title}` }

/** Sistema › Red de equipos: adapter, switch, server VLANs, ports, switch setup and manual instructions. */
export default async function SistemaRedEquiposPage() {
  const user = await adminPage()
  const data = await getEquipnetPage(user)
  return <EquipnetView status={data.status} manual={data.manual} />
}
