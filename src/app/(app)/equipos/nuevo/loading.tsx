import { Page } from "@/components/common/page"
import { Skeleton } from "@/components/ui/skeleton"
import { pages } from "@/lib/i18n/shell"

/** Wizard skeleton: title, the step list on the left and the template cards of step 1. */
export default function NuevoEquipoLoading() {
  return (
    <Page aria-busy="true">
      <span className="sr-only" role="status">{pages.loading}</span>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-7 w-44" />
        <Skeleton className="h-4 w-64" />
      </div>
      <div className="grid gap-6 xl:grid-cols-[13.5rem_minmax(0,1fr)] xl:gap-10">
        <div className="hidden flex-col gap-5 xl:flex">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="flex items-start gap-3">
              <Skeleton className="size-6 rounded-full" />
              <div className="flex flex-1 flex-col gap-1.5"><Skeleton className="h-4 w-28" /><Skeleton className="h-3 w-36" /></div>
            </div>
          ))}
        </div>
        <Skeleton className="h-10 xl:hidden" />
        <div className="flex flex-col gap-4">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-4 w-96 max-w-full" />
          <div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-3">
            {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-28 rounded-lg" />)}
          </div>
        </div>
      </div>
    </Page>
  )
}
