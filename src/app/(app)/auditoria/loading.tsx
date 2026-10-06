import { Page } from "@/components/common/page"
import { Skeleton } from "@/components/ui/skeleton"
import { pages } from "@/lib/i18n/shell"

/** Auditoría skeleton: header, filter bar and the table rows. */
export default function AuditoriaLoading() {
  return (
    <Page aria-busy="true">
      <span className="sr-only" role="status">{pages.loading}</span>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-7 w-36" />
          <Skeleton className="h-4 w-64" />
        </div>
        <Skeleton className="h-8 w-32" />
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5"><Skeleton className="h-4 w-16" /><Skeleton className="h-8 w-80" /></div>
        {[44, 52, 52, 36].map((w, i) => (
          <div key={i} className="flex flex-col gap-1.5"><Skeleton className="h-4 w-20" /><Skeleton className="h-8" style={{ width: `${w * 4}px` }} /></div>
        ))}
      </div>
      <div className="rounded-lg border bg-card">
        <div className="flex h-9 items-center gap-6 border-b px-3">
          {[24, 16, 28, 20, 20, 14, 16].map((w, i) => <Skeleton key={i} className="h-3" style={{ width: `${w * 4}px` }} />)}
        </div>
        {Array.from({ length: 10 }, (_, i) => (
          <div key={i} className="flex h-9 items-center gap-6 border-b px-3 last:border-0">
            <Skeleton className="h-3.5 w-36" />
            <Skeleton className="h-3.5 w-20" />
            <Skeleton className="h-3.5" style={{ width: `${100 + ((i * 37) % 60)}px` }} />
            <Skeleton className="h-3.5 w-24" />
            <Skeleton className="h-3.5 w-20" />
          </div>
        ))}
      </div>
    </Page>
  )
}
