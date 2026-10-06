import type { Metadata } from "next"
import { ShieldCheckIcon, ShieldPlusIcon } from "lucide-react"
import { RolesTable } from "@/components/admin/roles-table"
import { AppLink } from "@/components/common/app-link"
import { EmptyState } from "@/components/common/empty-state"
import { Page, PageHeader } from "@/components/common/page"
import { Button } from "@/components/ui/button"
import { roles as t } from "@/lib/i18n/admin"
import { listRoles } from "@/server/queries/users"
import { adminPage } from "../sistema/_lib/guard"

export const metadata: Metadata = { title: t.title }

/** Roles (§8.9): Nombre, Descripción, Usuarios, Equipos. Admin only. */
export default async function RolesPage() {
  await adminPage()
  const rows = await listRoles()
  const newButton = (
    <Button asChild variant="primary">
      <AppLink href="/roles/nuevo"><ShieldPlusIcon aria-hidden />{t.newRole}</AppLink>
    </Button>
  )
  return (
    <Page>
      <PageHeader title={t.title} summary={rows.length ? t.summary(rows.length) : undefined} actions={rows.length ? newButton : undefined} />
      {rows.length ? (
        <>
          <p className="max-w-[72ch] text-body text-muted-foreground">{t.explanation}</p>
          <RolesTable rows={rows} />
        </>
      ) : (
        <EmptyState icon={ShieldCheckIcon} title={t.emptyTitle} actions={newButton}>{t.emptyBody}</EmptyState>
      )}
    </Page>
  )
}
