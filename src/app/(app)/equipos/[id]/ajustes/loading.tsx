import { Page } from "@/components/common/page"
import { Skeleton } from "@/components/ui/skeleton"
import { pages } from "@/lib/i18n/shell"

/** Ajustes skeleton: the section index, identity fields and console rows with their binding cells. */
export default function AjustesLoading() {
  return (
    <Page aria-busy="true">
      <span className="sr-only" role="status">{pages.loading}</span>
      <div className="grid gap-8 xl:grid-cols-[11rem_minmax(0,1fr)]">
        <div className="hidden flex-col gap-2 xl:flex">
          {[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-4 w-24" />)}
        </div>
        <div className="flex max-w-5xl flex-col gap-10">
          <div className="flex flex-col gap-3">
            <Skeleton className="h-5 w-28" />
            <Skeleton className="h-4 w-80 max-w-full" />
            <div className="grid gap-5 md:grid-cols-2"><Skeleton className="h-14" /><Skeleton className="h-14" /><Skeleton className="h-20 md:col-span-2" /></div>
          </div>
          <div className="flex flex-col gap-2">
            <Skeleton className="h-5 w-24" />
            {[0, 1].map((i) => <Skeleton key={i} className="h-24 rounded-lg" />)}
          </div>
        </div>
      </div>
    </Page>
  )
}
