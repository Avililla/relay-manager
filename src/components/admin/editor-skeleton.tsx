import { Page } from "@/components/common/page"
import { Panel, PanelBody, PanelHeader } from "@/components/ui/panel"
import { Skeleton } from "@/components/ui/skeleton"
import { pages } from "@/lib/i18n/shell"

/** One form field placeholder: label, control, help line. `full` spans both columns of the panel grid. */
type FieldShape = "half" | "full"

export interface EditorSkeletonProps {
  /** Detail pages carry a meta line under the title (username, "1 usuario · 1 equipo"). */
  summary?: boolean
  /** The role editor opens with a one-line explanation above the panels. */
  lead?: boolean
  /** Form panels, top to bottom, each with its fields. */
  panels: FieldShape[][]
  /** Context column panels, each with its number of rows. */
  aside: number[]
}

function FieldSkeleton({ shape }: { shape: FieldShape }) {
  return (
    <div className={shape === "full" ? "flex flex-col gap-2 md:col-span-2" : "flex flex-col gap-2"}>
      <Skeleton className="h-4 w-24" />
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-3.5 w-3/5" />
    </div>
  )
}

/**
 * Loading state of the Usuarios and Roles editors (§8.9: skeletons shaped like the content): page header, the
 * form panels and the 22 rem context column, on the same grid as UserForm and RoleForm. Static, no pulse (§8.5).
 */
export function EditorSkeleton({ summary, lead, panels, aside }: EditorSkeletonProps) {
  return (
    <Page aria-busy="true">
      <span className="sr-only" role="status">{pages.loading}</span>
      <div className="flex flex-col gap-1.5">
        <Skeleton className="h-7 w-48" />
        {summary ? <Skeleton className="h-4 w-28" /> : null}
      </div>
      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="flex min-w-0 flex-col gap-5">
          {lead ? <Skeleton className="h-10 w-full rounded-lg" /> : null}
          {panels.map((fields, p) => (
            <Panel key={p}>
              <PanelHeader><Skeleton className="h-5 w-36" /></PanelHeader>
              <PanelBody className="grid gap-4 md:grid-cols-2">
                {fields.map((shape, i) => <FieldSkeleton key={i} shape={shape} />)}
              </PanelBody>
            </Panel>
          ))}
        </div>
        <div className="flex min-w-0 flex-col gap-5">
          {aside.map((rows, p) => (
            <Panel key={p}>
              <PanelHeader><Skeleton className="h-5 w-32" /></PanelHeader>
              <PanelBody className="gap-3">
                {Array.from({ length: rows }, (_, i) => <Skeleton key={i} className={i % 2 ? "h-4 w-4/5" : "h-4 w-full"} />)}
              </PanelBody>
            </Panel>
          ))}
        </div>
      </div>
    </Page>
  )
}
