import type { Metadata } from "next"
import { BackupsPanel, RestoreNote } from "@/components/admin/backups-panel"
import { ConfigPanel } from "@/components/admin/config-panel"
import { BackupSettingsForm } from "@/components/admin/settings-forms"
import { system as t } from "@/lib/i18n/admin"
import { getSettings } from "@/server/queries/settings"
import { listBackups } from "@/server/queries/system"
import { getRuntime } from "@/server/runtime/registry"
import { adminPage } from "../_lib/guard"

export const metadata: Metadata = { title: `${t.tabs.copias} · ${t.title}` }

/** Sistema > Copias: daily backup schedule, backups on disk, config export/import (dry run first), restore note. */
export default async function SistemaCopiasPage() {
  await adminPage()
  const [settings, backups] = await Promise.all([getSettings(), listBackups()])
  return (
    <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="flex min-w-0 flex-col gap-5">
        <BackupSettingsForm settings={settings} />
        <BackupsPanel backups={backups} backupDir={getRuntime().config.backupDir} />
      </div>
      <div className="flex min-w-0 flex-col gap-5">
        <RestoreNote />
        <ConfigPanel />
      </div>
    </div>
  )
}
