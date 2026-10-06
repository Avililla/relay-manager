import { ArrowLeftIcon } from "lucide-react"
import { AppLink } from "@/components/common/app-link"
import { Page } from "@/components/common/page"
import { PageMeta } from "@/components/shell/page-meta"
import { buttonVariants } from "@/components/ui/button"
import { banco, errorsText } from "@/lib/i18n/banco"

/** An equipment that does not exist or that the viewer cannot see (same answer for both, §6.8). */
export default function EquipoNotFound() {
  return (
    <Page className="max-w-2xl py-10 md:py-14">
      <PageMeta breadcrumbs={[{ label: banco.title, href: "/" }, { label: errorsText.notFoundTitle }]} />
      <p className="font-mono text-data text-faint-foreground">404</p>
      <h1 className="text-title text-foreground">{errorsText.notFoundTitle}</h1>
      <p className="text-body text-muted-foreground">{errorsText.notFoundBody}</p>
      <div>
        <AppLink href="/" className={buttonVariants({ variant: "primary", size: "lg" })}>
          <ArrowLeftIcon aria-hidden />
          {errorsText.backToBanco}
        </AppLink>
      </div>
    </Page>
  )
}
