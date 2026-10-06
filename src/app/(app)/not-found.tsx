import { ArrowLeftIcon } from "lucide-react"
import { AppLink } from "@/components/common/app-link"
import { Page } from "@/components/common/page"
import { buttonVariants } from "@/components/ui/button"
import { pages } from "@/lib/i18n/shell"

/** 404 inside the shell (a page called notFound(), e.g. an equipment the viewer cannot see). */
export default function AppNotFound() {
  return (
    <Page className="max-w-2xl py-10 md:py-14">
      <p className="font-mono text-data text-faint-foreground">404</p>
      <h1 className="text-title text-foreground">{pages.notFoundTitle}</h1>
      <p className="text-body text-muted-foreground">{pages.notFoundBody}</p>
      <div>
        <AppLink href="/" className={buttonVariants({ variant: "primary", size: "lg" })}>
          <ArrowLeftIcon aria-hidden />
          {pages.backToBanco}
        </AppLink>
      </div>
    </Page>
  )
}
