import { Skeleton } from "@/components/ui/skeleton"
import { pages } from "@/lib/i18n/shell"

/** Content-shaped skeleton of the Consolas tab (§8.9): two console panes and the status bar. No pulse. */
export default function EquipoLoading() {
  return (
    <div className="flex h-full min-h-0 flex-col" aria-busy="true">
      <span className="sr-only" role="status">{pages.loading}</span>
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-2 p-2 md:grid-cols-2 md:p-3">
        {[0, 1].map((i) => (
          <div key={i} className="flex min-h-0 flex-col overflow-hidden rounded-md border bg-card max-md:last:hidden">
            <div className="flex h-7 items-center gap-2 border-b px-2">
              <Skeleton className="size-2 rounded-full" />
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-3 w-24" />
              <Skeleton className="ml-auto h-3 w-16" />
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-2 bg-terminal-bg p-3">
              {/* Terminal foreground (#dbdee1) at 8 %: the panes stay dark in both themes. */}
              {[72, 54, 80, 38, 66].map((w) => <div key={w} className="h-3 rounded-sm" style={{ width: `${w}%`, backgroundColor: "rgb(219 222 225 / 0.08)" }} />)}
            </div>
          </div>
        ))}
      </div>
      <div className="flex h-8 shrink-0 items-center gap-3 border-t bg-card px-2">
        <Skeleton className="h-3 w-16" />
        <Skeleton className="ml-auto h-5 w-40" />
      </div>
    </div>
  )
}
