import { Page } from "@/components/common/page"
import { Skeleton } from "@/components/ui/skeleton"
import { pages } from "@/lib/i18n/shell"

/** Content-shaped skeleton of the Banco (§8.9): header, filter bar and unit cards with console strips. No pulse. */
export default function BancoLoading() {
  return (
    <Page aria-busy="true">
      <span className="sr-only" role="status">{pages.loading}</span>
      <div className="flex items-end justify-between gap-4">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-7 w-28" />
          <Skeleton className="h-4 w-56" />
        </div>
        <Skeleton className="h-8 w-32" />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Skeleton className="h-8 w-full sm:w-72" />
        <Skeleton className="h-7 w-64" />
        <Skeleton className="h-7 w-40" />
      </div>
      <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(min(340px,100%),1fr))]">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="flex flex-col rounded-lg border bg-card">
            <div className="flex items-start justify-between gap-3 px-3 pt-3 pb-2">
              <div className="flex flex-col gap-1.5">
                <Skeleton className="h-4.5 w-32" />
                <Skeleton className="h-4 w-24" />
              </div>
              <Skeleton className="h-6 w-24" />
            </div>
            <div className="mx-3 mb-3 flex flex-col gap-2 rounded-md bg-muted/60 px-2 py-2">
              {[0, 1].map((k) => (
                <div key={k} className="flex h-4 items-center gap-2.5">
                  <Skeleton className="size-2 rounded-full" />
                  <Skeleton className="h-3 w-14" />
                  <Skeleton className="h-3 w-12" />
                  <Skeleton className="h-3 flex-1" />
                </div>
              ))}
            </div>
            <div className="mt-auto flex justify-end gap-2 border-t px-3 py-2">
              <Skeleton className="h-7 w-28" />
              <Skeleton className="h-7 w-20" />
            </div>
          </div>
        ))}
      </div>
    </Page>
  )
}
