import { Page } from "@/components/common/page"
import { Skeleton } from "@/components/ui/skeleton"
import { pages } from "@/lib/i18n/shell"

/** Template editor skeleton: identity fields and slot rows on the left, the unit preview on the right. */
export default function TemplateEditorLoading() {
  return (
    <Page aria-busy="true">
      <span className="sr-only" role="status">{pages.loading}</span>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-7 w-44" />
          <Skeleton className="h-4 w-64" />
        </div>
        <div className="flex gap-2"><Skeleton className="h-8 w-28" /><Skeleton className="h-8 w-40" /></div>
      </div>
      <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="flex flex-col gap-8">
          <div className="flex flex-col gap-3">
            <Skeleton className="h-5 w-28" />
            <div className="grid max-w-3xl gap-5 md:grid-cols-2">
              <Skeleton className="h-14" /><Skeleton className="h-14" /><Skeleton className="h-20 md:col-span-2" />
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <Skeleton className="h-5 w-24" />
            {[0, 1].map((i) => <Skeleton key={i} className="h-12 rounded-lg" />)}
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <Skeleton className="h-5 w-28" />
          <Skeleton className="h-36 rounded-lg" />
        </div>
      </div>
    </Page>
  )
}
