import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { UserAccountPanel } from "@/components/admin/user-account-panel"
import { UserForm } from "@/components/admin/user-form"
import { Page, PageHeader } from "@/components/common/page"
import { PageMeta } from "@/components/shell/page-meta"
import { Tag } from "@/components/ui/tag"
import { IdSchema } from "@/lib/contracts/common"
import { users as t } from "@/lib/i18n/admin"
import { getAuthUser } from "@/server/authz"
import { getUser, listRoles } from "@/server/queries/users"
import { adminPage } from "../../sistema/_lib/guard"
import { equipmentAccessList } from "../../sistema/_lib/data"

type Params = { params: Promise<{ id: string }> }

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { id } = await params
  const parsed = IdSchema.safeParse(id)
  // Metadata renders before the page guard: only admins get the name in the title.
  const viewer = await getAuthUser()
  const u = parsed.success && viewer?.isAdmin && !viewer.mustChangePassword ? await getUser(parsed.data).catch(() => null) : null
  return { title: u ? u.name : t.title }
}

/** User detail/edit (§8.9): the same fields as "Nuevo usuario" plus the account actions. */
export default async function UsuarioPage({ params }: Params) {
  const viewer = await adminPage()
  const { id } = await params
  const parsed = IdSchema.safeParse(id)
  if (!parsed.success) notFound()
  const [user, roles, equipment] = await Promise.all([getUser(parsed.data), listRoles(), equipmentAccessList(viewer)])
  if (!user) notFound()
  return (
    <Page>
      <PageMeta breadcrumbs={[{ label: t.title, href: "/usuarios" }, { label: user.name }]} />
      <PageHeader
        title={user.id === viewer.id ? <span className="inline-flex items-center gap-2">{user.name}<Tag tone="brand">{t.you}</Tag></span> : user.name}
        summary={<span className="font-mono">{user.username}</span>}
      />
      <UserForm
        key={user.id}
        mode="edit"
        user={user}
        roles={roles}
        equipment={equipment}
        viewerId={viewer.id}
        aside={<UserAccountPanel user={user} viewerId={viewer.id} />}
      />
    </Page>
  )
}
