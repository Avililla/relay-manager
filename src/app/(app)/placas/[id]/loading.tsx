import { Page } from "@/components/common/page"
import { Skeleton } from "@/components/ui/skeleton"
import { pages } from "@/lib/i18n/shell"

/** Board detail skeleton: header with actions, the relay map grid and the connection panel. */
export default function PlacaLoading() {
  return (
    <Page aria-busy="true">
      <span className="sr-only" role="status">{pages.loading}</span>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-7 w-48" />
          <Skeleton className="h-5 w-80" />
        </div>
        <div className="flex gap-2">{[20, 20, 24, 26, 22].map((w, i) => <Skeleton key={i} className="h-8" style={{ width: `${w * 4}px` }} />)}</div>
      </div>
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
        <div className="rounded-lg border bg-card">
          <div className="border-b px-4 py-3"><Skeleton className="h-5 w-32" /></div>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-2 p-4">
            {Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-22 rounded-lg" />)}
          </div>
        </div>
        <div className="rounded-lg border bg-card">
          <div className="border-b px-4 py-3"><Skeleton className="h-5 w-24" /></div>
          <div className="flex flex-col gap-3 p-4">{Array.from({ length: 7 }, (_, i) => <Skeleton key={i} className="h-4" style={{ width: `${88 - i * 6}%` }} />)}</div>
        </div>
      </div>
    </Page>
  )
}
