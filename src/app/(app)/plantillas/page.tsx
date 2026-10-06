import type { Metadata } from "next"
import { redirect } from "next/navigation"
import { PlusIcon } from "lucide-react"
import { AppLink } from "@/components/common/app-link"
import { Page, PageHeader } from "@/components/common/page"
import { PageMeta } from "@/components/shell/page-meta"
import { InlineAlert } from "@/components/common/inline-alert"
import { ReloadTemplatesButton } from "@/components/templates/reload-templates-button"
import { TemplatesTable } from "@/components/templates/templates-table"
import { Button } from "@/components/ui/button"
import { nav } from "@/lib/i18n/shell"
import { templateText as t } from "@/lib/i18n/wizard"
import { getAuthUser } from "@/server/authz"
import { getTemplatesProfileInfo, listTemplates } from "@/server/queries/templates"
import { adminPageMetadata } from "../_lib/admin-metadata"

export async function generateMetadata(): Promise<Metadata> {
  return adminPageMetadata(t.pageTitle)
}

/** Plantillas (§8.9, admin): every template with its consoles, relays and the equipment created from it. */
export default async function PlantillasPage() {
  const user = await getAuthUser()
  if (!user) redirect("/login")
  if (!user.isAdmin) redirect("/") // §6.2: non-admins go to the Banco, never to an error page
  const templates = await listTemplates()
  const profile = getTemplatesProfileInfo()
  const review = templates.filter((x) => x.needsReview).length
  return (
    <Page>
      <PageMeta breadcrumbs={[{ label: nav.plantillas }]} />
      <PageHeader
        title={t.pageTitle}
        summary={t.summary(templates.length, review)}
        actions={
          <>
            <ReloadTemplatesButton />
            <Button asChild variant="primary" size="lg">
              <AppLink href="/plantillas/nueva"><PlusIcon aria-hidden />{t.newButton}</AppLink>
            </Button>
          </>
        }
      >
        <p className="mt-1 max-w-[72ch] text-meta text-muted-foreground">{t.intro}</p>
      </PageHeader>
      {profile.errors.length ? (
        <InlineAlert tone="danger" role="alert" title={t.profileErrorsTitle}>
          <p>{t.profileErrorsBody}</p>
          <ul className="mt-1 list-disc pl-5 font-mono text-data">
            {profile.errors.map((e) => <li key={e}>{e}</li>)}
          </ul>
        </InlineAlert>
      ) : null}
      <TemplatesTable templates={templates} profilePath={profile.dir ?? profile.path} />
    </Page>
  )
}
