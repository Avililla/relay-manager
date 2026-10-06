import type { Metadata } from "next"
import { RoleForm } from "@/components/admin/role-form"
import { Page, PageHeader } from "@/components/common/page"
import { PageMeta } from "@/components/shell/page-meta"
import { roles as t } from "@/lib/i18n/admin"
import { listUsers } from "@/server/queries/users"
import { equipmentAccessList } from "../../sistema/_lib/data"
import { adminPage } from "../../sistema/_lib/guard"
import { roleMembers } from "../_lib/members"

export const metadata: Metadata = { title: t.newRole }

export default async function NuevoRolPage() {
  const viewer = await adminPage()
  const [users, equipment] = await Promise.all([listUsers(), equipmentAccessList(viewer)])
  return (
    <Page>
      <PageMeta breadcrumbs={[{ label: t.title, href: "/roles" }, { label: t.newRole }]} />
      <PageHeader title={t.newRole} />
      <RoleForm role={null} users={roleMembers(users)} equipment={equipment} />
    </Page>
  )
}
