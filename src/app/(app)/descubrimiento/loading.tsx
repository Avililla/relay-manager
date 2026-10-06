import { Page } from "@/components/common/page"
import { Skeleton } from "@/components/ui/skeleton"
import { pages } from "@/lib/i18n/shell"

/** Descubrimiento skeleton: title, tabs, toolbar and two adapter groups. */
export default function DescubrimientoLoading() {
  return (
    <Page aria-busy="true">
      <span className="sr-only" role="status">{pages.loading}</span>
      <Skeleton className="h-7 w-44" />
      <div className="flex h-9 items-end gap-4 border-b pb-2"><Skeleton className="h-4 w-24" /><Skeleton className="h-4 w-28" /></div>
      <div className="flex flex-wrap items-center gap-4"><Skeleton className="h-8 w-40" /><Skeleton className="ml-auto h-4 w-64" /></div>
      {[4, 3].map((rows, g) => (
        <div key={g} className="rounded-lg border bg-card">
          <div className="flex items-center gap-3 border-b px-4 py-3">
            <Skeleton className="size-4" /><Skeleton className="h-4 w-56" /><Skeleton className="h-5 w-16" /><Skeleton className="h-5 w-20" />
            <Skeleton className="ml-auto h-7 w-36" />
          </div>
          {Array.from({ length: rows }, (_, i) => (
            <div key={i} className="flex h-10 items-center gap-4 border-b px-4 last:border-0">
              <Skeleton className="h-3.5 w-6" /><Skeleton className="h-3.5 w-16" /><Skeleton className="h-3.5 w-72" /><Skeleton className="ml-auto h-5 w-28" />
            </div>
          ))}
        </div>
      ))}
    </Page>
  )
}
