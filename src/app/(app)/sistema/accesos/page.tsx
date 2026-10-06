import type { Metadata } from "next"
import { AccessSystemView } from "@/components/accesses/access-system-view"
import { system as t } from "@/lib/i18n/admin"
import { getAccessSystem } from "@/server/queries/accesses"
import { adminPage } from "../_lib/guard"

export const metadata: Metadata = { title: `${t.tabs.accesos} · ${t.title}` }

/** Sistema > Accesos: port map of the bench, hw_server and JTAG cables. */
export default async function SistemaAccesosPage() {
  const user = await adminPage()
  return <AccessSystemView data={await getAccessSystem(user)} />
}
