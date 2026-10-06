import { ArrowLeftIcon } from "lucide-react"
import { AppLink } from "@/components/common/app-link"
import { Page } from "@/components/common/page"
import { Button } from "@/components/ui/button"
import { boards } from "@/lib/i18n/hardware"

/** A board id that does not exist (deleted, or a stale link). */
export default function PlacaNotFound() {
  return (
    <Page className="max-w-2xl py-10 md:py-14">
      <div className="flex flex-col items-start gap-3">
        <h1 className="text-title text-foreground">{boards.notFoundTitle}</h1>
        <p className="text-body text-muted-foreground">{boards.notFoundBody}</p>
        <Button asChild variant="primary" size="lg">
          <AppLink href="/placas"><ArrowLeftIcon aria-hidden />{boards.backToList}</AppLink>
        </Button>
      </div>
    </Page>
  )
}
