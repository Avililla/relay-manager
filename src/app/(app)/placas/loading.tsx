import { Page } from "@/components/common/page"
import { Skeleton } from "@/components/ui/skeleton"
import { pages } from "@/lib/i18n/shell"

/** Placas de relés skeleton: header and the board table. */
export default function PlacasLoading() {
  return (
    <Page aria-busy="true">
      <span className="sr-only" role="status">{pages.loading}</span>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-7 w-44" />
          <Skeleton className="h-4 w-60" />
        </div>
        <div className="flex gap-2"><Skeleton className="h-8 w-32" /><Skeleton className="h-8 w-32" /></div>
      </div>
      <div className="rounded-lg border bg-card">
        <div className="flex h-9 items-center gap-8 border-b px-3">
          {[20, 14, 24, 24, 10, 16, 18].map((w, i) => <Skeleton key={i} className="h-3" style={{ width: `${w * 4}px` }} />)}
        </div>
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="flex h-12 items-center gap-8 border-b px-3 last:border-0">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-3.5 w-14" />
            <Skeleton className="h-3.5 w-28" />
            <Skeleton className="h-3.5 w-36" />
            <Skeleton className="h-3.5 w-10" />
            <Skeleton className="h-5 w-24" />
          </div>
        ))}
      </div>
    </Page>
  )
}
