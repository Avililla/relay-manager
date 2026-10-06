import type { Metadata } from "next"
import { KeyRoundIcon } from "lucide-react"
import { ChangePasswordForm, PreferencesPanel } from "@/components/admin/account-forms"
import { InlineAlert } from "@/components/common/inline-alert"
import { Page, PageHeader } from "@/components/common/page"
import { PageMeta } from "@/components/shell/page-meta"
import { Panel, PanelBody, PanelDescription, PanelHeader, PanelTitle } from "@/components/ui/panel"
import { account as t } from "@/lib/i18n/admin"
import { userPage } from "../sistema/_lib/guard"

export const metadata: Metadata = { title: t.title }

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-2">
      <dt className="text-meta text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-right text-body text-foreground">{children}</dd>
    </div>
  )
}

/**
 * Mi cuenta (§8.9): profile (read-only), "Cambiar contraseña" and per-browser preferences. Reached with ?cambiar=1
 * by the proxy while the password must be changed: then a blocking explanation leads the page.
 */
export default async function CuentaPage() {
  const user = await userPage()
  return (
    <Page>
      <PageMeta breadcrumbs={[{ label: t.title }]} />
      <PageHeader title={t.title} summary={<span className="font-mono">{user.username}</span>} />
      {user.mustChangePassword ? (
        <InlineAlert tone="warn" icon={KeyRoundIcon} title={t.mustChangeTitle}>{t.mustChangeBody}</InlineAlert>
      ) : null}
      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="flex min-w-0 flex-col gap-5">
          <ChangePasswordForm username={user.username} mustChange={user.mustChangePassword} />
          <PreferencesPanel />
        </div>
        <div className="flex min-w-0 flex-col gap-5 xl:sticky xl:top-5">
          <Panel>
            <PanelHeader><PanelTitle as="h2">{t.profileSection}</PanelTitle></PanelHeader>
            <PanelBody className="gap-2">
              <dl className="flex flex-col divide-y">
                <Row label={t.name}>{user.name}</Row>
                <Row label={t.username}><span className="font-mono text-data">{user.username}</span></Row>
                <Row label={t.role}>{user.isAdmin ? t.roleAdmin : t.roleUser}</Row>
              </dl>
              <PanelDescription>{t.profileHelp}</PanelDescription>
            </PanelBody>
          </Panel>
        </div>
      </div>
    </Page>
  )
}
