import { Skeleton } from "@/components/ui/skeleton"
import { pages } from "@/lib/i18n/shell"

/** Sistema tab skeleton (inside the layout's header and tabs): a form panel and the context column. */
export default function Loading() {
  return (
    <div aria-busy="true" className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_22rem]">
      <span className="sr-only" role="status">{pages.loading}</span>
      <div className="flex flex-col gap-5">
        {[0, 1].map((p) => (
          <div key={p} className="rounded-lg border bg-card">
            <div className="border-b px-4 py-3"><Skeleton className="h-5 w-40" /></div>
            <div className="grid gap-5 p-4 md:grid-cols-2">
              {[0, 1, 2].map((i) => (
                <div key={i} className="flex flex-col gap-2">
                  <Skeleton className="h-4 w-36" />
                  <Skeleton className="h-8 w-44" />
                  <Skeleton className="h-3.5 w-64" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="rounded-lg border bg-card">
        <div className="border-b px-4 py-3"><Skeleton className="h-5 w-32" /></div>
        <div className="flex flex-col gap-3 p-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-5" />)}</div>
      </div>
    </div>
  )
}
