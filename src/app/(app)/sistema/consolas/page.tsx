import type { Metadata } from "next"
import { CaptureSettingsForm } from "@/components/admin/settings-forms"
import { system as t } from "@/lib/i18n/admin"
import { getSettings } from "@/server/queries/settings"
import { getRuntime } from "@/server/runtime/registry"
import { captureStatus } from "../_lib/data"
import { adminPage } from "../_lib/guard"

export const metadata: Metadata = { title: `${t.tabs.consolas} · ${t.title}` }

/** Sistema > Consolas: continuous capture retention and input capture, with the capture dir, size and state. */
export default async function SistemaConsolasPage() {
  await adminPage()
  const settings = await getSettings()
  const status = captureStatus()
  return <CaptureSettingsForm settings={settings} status={{ ...status, dir: getRuntime().config.captureDir }} />
}
