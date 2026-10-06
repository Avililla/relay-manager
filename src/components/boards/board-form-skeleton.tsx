import { Page } from "@/components/common/page"
import { Skeleton } from "@/components/ui/skeleton"
import { pages } from "@/lib/i18n/shell"

/** Board form skeleton: the fields column and the "Probar conexión" panel. */
export function BoardFormSkeleton() {
  return (
    <Page aria-busy="true">
      <span className="sr-only" role="status">{pages.loading}</span>
      <Skeleton className="h-7 w-56" />
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
        <div className="flex flex-col gap-6 rounded-lg border bg-card p-4">
          <div className="flex flex-col gap-2"><Skeleton className="h-4 w-20" /><Skeleton className="h-8 w-full" /></div>
          <div className="grid gap-2 sm:grid-cols-2">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-18 rounded-lg" />)}</div>
          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_8rem_8rem]">{[0, 1, 2].map((i) => <div key={i} className="flex flex-col gap-2"><Skeleton className="h-4 w-24" /><Skeleton className="h-8" /></div>)}</div>
          <div className="grid gap-4 sm:grid-cols-2">{[0, 1].map((i) => <div key={i} className="flex flex-col gap-2"><Skeleton className="h-4 w-24" /><Skeleton className="h-8" /></div>)}</div>
        </div>
        <div className="flex flex-col gap-3 rounded-lg border bg-card p-4">
          <Skeleton className="h-5 w-36" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-8 w-40" />
        </div>
      </div>
    </Page>
  )
}
