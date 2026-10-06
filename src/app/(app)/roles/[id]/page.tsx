import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { RoleForm } from "@/components/admin/role-form"
import { Page, PageHeader } from "@/components/common/page"
import { PageMeta } from "@/components/shell/page-meta"
import { IdSchema } from "@/lib/contracts/common"
import { roles as t } from "@/lib/i18n/admin"
import { getAuthUser } from "@/server/authz"
import { getRole, listUsers } from "@/server/queries/users"
import { equipmentAccessList } from "../../sistema/_lib/data"
import { adminPage } from "../../sistema/_lib/guard"
import { roleMembers } from "../_lib/members"

type Params = { params: Promise<{ id: string }> }

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { id } = await params
  const parsed = IdSchema.safeParse(id)
  // Metadata renders before the page guard: only admins get the name in the title.
  const viewer = await getAuthUser()
  const r = parsed.success && viewer?.isAdmin && !viewer.mustChangePassword ? await getRole(parsed.data).catch(() => null) : null
  return { title: r ? r.name : t.title }
}

export default async function RolPage({ params }: Params) {
  const viewer = await adminPage()
  const { id } = await params
  const parsed = IdSchema.safeParse(id)
  if (!parsed.success) notFound()
  const [role, users, equipment] = await Promise.all([getRole(parsed.data), listUsers(), equipmentAccessList(viewer)])
  if (!role) notFound()
  return (
    <Page>
      <PageMeta breadcrumbs={[{ label: t.title, href: "/roles" }, { label: role.name }]} />
      <PageHeader title={role.name} summary={t.headerSummary(role.userCount, role.equipmentCount)} />
      <RoleForm key={role.id} role={role} users={roleMembers(users)} equipment={equipment} />
    </Page>
  )
}
