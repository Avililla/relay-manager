import { Page } from "@/components/common/page"
import { Skeleton } from "@/components/ui/skeleton"
import { pages } from "@/lib/i18n/shell"

/** Generic header + panel skeleton (§8.8). Content-shaped skeletons belong to each W2 route segment. */
export default function AppLoading() {
  return (
    <Page aria-busy="true">
      <span className="sr-only" role="status">{pages.loading}</span>
      <div className="flex items-end justify-between gap-4">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-7 w-48" />
          <Skeleton className="h-4 w-72" />
        </div>
        <Skeleton className="h-9 w-32" />
      </div>
      <div className="rounded-lg border bg-card">
        <div className="border-b px-4 py-3"><Skeleton className="h-5 w-40" /></div>
        <div className="flex flex-col gap-3 p-4">
          {[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-7" style={{ width: `${92 - i * 9}%` }} />)}
        </div>
      </div>
    </Page>
  )
}
