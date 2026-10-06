import type { Metadata } from "next"
import { ReservationSettingsForm } from "@/components/admin/settings-forms"
import { system as t } from "@/lib/i18n/admin"
import { getSettings } from "@/server/queries/settings"
import { adminPage } from "../_lib/guard"

export const metadata: Metadata = { title: `${t.tabs.reservas} · ${t.title}` }

/** Sistema > Reservas: reservation duration and the warning before it expires. */
export default async function SistemaReservasPage() {
  await adminPage()
  const settings = await getSettings()
  return <ReservationSettingsForm settings={settings} />
}
