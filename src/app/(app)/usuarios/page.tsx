import type { Metadata } from "next"
import { UserPlusIcon, UsersIcon } from "lucide-react"
import { UsersTable } from "@/components/admin/users-table"
import { AppLink } from "@/components/common/app-link"
import { EmptyState } from "@/components/common/empty-state"
import { Page, PageHeader } from "@/components/common/page"
import { Button } from "@/components/ui/button"
import { users as t } from "@/lib/i18n/admin"
import { listUsers } from "@/server/queries/users"
import { adminPage } from "../sistema/_lib/guard"

export const metadata: Metadata = { title: t.title }

/** Usuarios (§8.9): list with status and last access. Admin only; others are redirected to Banco. */
export default async function UsuariosPage() {
  const viewer = await adminPage()
  const rows = await listUsers()
  const admins = rows.filter((u) => u.isAdmin && !u.disabled).length
  const disabled = rows.filter((u) => u.disabled).length
  const newButton = (
    <Button asChild variant="primary">
      <AppLink href="/usuarios/nuevo"><UserPlusIcon aria-hidden />{t.newUser}</AppLink>
    </Button>
  )
  return (
    <Page>
      <PageHeader title={t.title} summary={t.summary(rows.length, admins, disabled)} actions={newButton} />
      <UsersTable rows={rows} viewerId={viewer.id} />
      {rows.length <= 1 ? (
        <EmptyState icon={UsersIcon} title={t.onlyYouTitle}>
          {t.onlyYouBody}
        </EmptyState>
      ) : null}
    </Page>
  )
}
