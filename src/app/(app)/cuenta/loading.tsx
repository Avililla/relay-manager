import { Page } from "@/components/common/page"
import { Skeleton } from "@/components/ui/skeleton"
import { pages } from "@/lib/i18n/shell"

/** Mi cuenta skeleton: header, the password panel and the profile column. */
export default function Loading() {
  return (
    <Page aria-busy="true">
      <span className="sr-only" role="status">{pages.loading}</span>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-7 w-32" />
        <Skeleton className="h-4 w-24" />
      </div>
      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="rounded-lg border bg-card">
          <div className="border-b px-4 py-3"><Skeleton className="h-5 w-44" /></div>
          <div className="flex flex-col gap-4 p-4">
            <Skeleton className="h-4 w-80" />
            <Skeleton className="h-8 max-w-md" />
            <div className="grid gap-4 md:grid-cols-2"><Skeleton className="h-8" /><Skeleton className="h-8" /></div>
          </div>
        </div>
        <div className="rounded-lg border bg-card">
          <div className="border-b px-4 py-3"><Skeleton className="h-5 w-20" /></div>
          <div className="flex flex-col gap-3 p-4">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-5" />)}</div>
        </div>
      </div>
    </Page>
  )
}
