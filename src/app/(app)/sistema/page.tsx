import type { Metadata } from "next"
import { GeneralSettingsForm } from "@/components/admin/settings-forms"
import { system as t } from "@/lib/i18n/admin"
import { getSettings } from "@/server/queries/settings"
import { adminPage } from "./_lib/guard"

export const metadata: Metadata = { title: `${t.tabs.general} · ${t.title}` }

/** Sistema > General: lab name and banner text (with a preview), audit retention. */
export default async function SistemaGeneralPage() {
  await adminPage()
  const settings = await getSettings()
  return <GeneralSettingsForm settings={settings} />
}
