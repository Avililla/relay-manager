import type { Metadata } from "next"
import { UserForm } from "@/components/admin/user-form"
import { Page, PageHeader } from "@/components/common/page"
import { PageMeta } from "@/components/shell/page-meta"
import { users as t } from "@/lib/i18n/admin"
import { listRoles } from "@/server/queries/users"
import { adminPage } from "../../sistema/_lib/guard"
import { equipmentAccessList } from "../../sistema/_lib/data"

export const metadata: Metadata = { title: t.newUser }

export default async function NuevoUsuarioPage() {
  const viewer = await adminPage()
  const [roles, equipment] = await Promise.all([listRoles(), equipmentAccessList(viewer)])
  return (
    <Page>
      <PageMeta breadcrumbs={[{ label: t.title, href: "/usuarios" }, { label: t.newUser }]} />
      <PageHeader title={t.newUser} />
      <UserForm mode="create" roles={roles} equipment={equipment} viewerId={viewer.id} />
    </Page>
  )
}
