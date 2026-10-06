import { Page } from "@/components/common/page"
import { Skeleton } from "@/components/ui/skeleton"
import { pages } from "@/lib/i18n/shell"

/** Usuarios / Roles list skeleton: header, search and a 36 px-row table (§8.9 loading). */
export default function Loading() {
  return (
    <Page aria-busy="true">
      <span className="sr-only" role="status">{pages.loading}</span>
      <div className="flex items-end justify-between gap-4">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-7 w-36" />
          <Skeleton className="h-4 w-64" />
        </div>
        <Skeleton className="h-8 w-36" />
      </div>
      <Skeleton className="h-8 w-72" />
      <div className="overflow-hidden rounded-lg border bg-card">
        <div className="flex h-9 items-center gap-6 border-b px-3">
          {[28, 16, 20, 12, 16, 14].map((w, i) => <Skeleton key={i} className="h-3" style={{ width: `${w}%` }} />)}
        </div>
        {[0, 1, 2, 3, 4, 5].map((r) => (
          <div key={r} className="flex h-9 items-center gap-6 border-b px-3 last:border-b-0">
            {[28, 16, 20, 12, 16, 14].map((w, i) => <Skeleton key={i} className="h-3.5" style={{ width: `${w - (r % 3) * 2}%` }} />)}
          </div>
        ))}
      </div>
    </Page>
  )
}
