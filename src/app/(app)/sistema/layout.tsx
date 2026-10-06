import { SystemTabs } from "@/components/admin/system-tabs"
import { Page, PageHeader } from "@/components/common/page"
import { system as t } from "@/lib/i18n/admin"
import { getRuntime } from "@/server/runtime/registry"
import { adminPage } from "./_lib/guard"

/** Sistema (§8.9): one header and the sub-navigation tabs (routes); every tab page guards itself too. */
export default async function SistemaLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  await adminPage()
  const { build, mode } = getRuntime().config
  return (
    <Page className="gap-5">
      <div className="flex flex-col gap-3">
        <PageHeader title={t.title} summary={t.summary(build.version, t.modes[mode])} />
        <SystemTabs />
      </div>
      {children}
    </Page>
  )
}
