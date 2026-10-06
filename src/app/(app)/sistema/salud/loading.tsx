import { Skeleton } from "@/components/ui/skeleton"
import { system as t } from "@/lib/i18n/admin"

/** Health checks can take a couple of seconds (external tools): summary bar plus grouped rows. */
export default function Loading() {
  return (
    <div aria-busy="true" className="flex flex-col gap-5">
      <span className="sr-only" role="status">{t.healthChecking}</span>
      <div className="flex items-center gap-4 rounded-lg border bg-card p-4">
        <Skeleton className="size-5 rounded-full" />
        <div className="flex flex-1 flex-col gap-2"><Skeleton className="h-5 w-72" /><Skeleton className="h-3.5 w-52" /></div>
        <Skeleton className="h-8 w-40" />
      </div>
      {[3, 5, 4].map((rows, g) => (
        <div key={g} className="rounded-lg border bg-card">
          <div className="border-b px-4 py-3"><Skeleton className="h-5 w-28" /></div>
          {Array.from({ length: rows }, (_, i) => (
            <div key={i} className="grid gap-4 border-b px-4 py-3 last:border-b-0 sm:grid-cols-[8.5rem_1fr]">
              <Skeleton className="h-4 w-20" />
              <div className="flex flex-col gap-2"><Skeleton className="h-4 w-48" /><Skeleton className="h-3.5 w-80 max-w-full" /></div>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
