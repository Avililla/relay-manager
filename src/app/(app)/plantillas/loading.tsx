import { Page } from "@/components/common/page"
import { Skeleton } from "@/components/ui/skeleton"
import { pages } from "@/lib/i18n/shell"

/** Plantillas list skeleton: header, search, and table rows shaped like the real columns. */
export default function PlantillasLoading() {
  return (
    <Page aria-busy="true">
      <span className="sr-only" role="status">{pages.loading}</span>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-7 w-40" />
          <Skeleton className="h-4 w-56" />
          <Skeleton className="h-4 w-96 max-w-full" />
        </div>
        <Skeleton className="h-9 w-40" />
      </div>
      <Skeleton className="h-8 w-72 max-w-full" />
      <div className="rounded-lg border bg-card">
        <div className="flex h-9 items-center gap-6 border-b px-3">
          {[28, 20, 10, 10, 14].map((w, i) => <Skeleton key={i} className="h-3" style={{ width: `${w}%` }} />)}
        </div>
        {[0, 1, 2, 3].map((r) => (
          <div key={r} className="flex h-9 items-center gap-6 border-b px-3 last:border-0">
            {[24, 22, 6, 6, 12].map((w, i) => <Skeleton key={i} className="h-3.5" style={{ width: `${w}%` }} />)}
          </div>
        ))}
      </div>
    </Page>
  )
}
