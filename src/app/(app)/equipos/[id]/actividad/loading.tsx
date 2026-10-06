import { Skeleton } from "@/components/ui/skeleton"
import { pages } from "@/lib/i18n/shell"

/** Content-shaped skeleton of the Actividad tab: heading and the audit table rows (36 px). No pulse. */
export default function ActividadLoading() {
  return (
    <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-3 px-4 py-4 md:px-6 md:py-5" aria-busy="true">
      <span className="sr-only" role="status">{pages.loading}</span>
      <div className="flex flex-col gap-1.5">
        <Skeleton className="h-5 w-28" />
        <Skeleton className="h-3.5 w-96 max-w-full" />
      </div>
      <div className="overflow-hidden rounded-lg border bg-card">
        <div className="flex h-9 items-center gap-6 border-b bg-secondary px-3">
          {[64, 56, 72, 60, 48].map((w, i) => <Skeleton key={i} className="h-3 bg-card" style={{ width: w }} />)}
        </div>
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="flex h-9 items-center gap-6 border-b px-3 last:border-b-0">
            <Skeleton className="h-3 w-32" />
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-3 w-40" />
            <Skeleton className="h-3 w-16" />
          </div>
        ))}
      </div>
    </div>
  )
}
