import { EyeIcon, EyeOffIcon } from "lucide-react"
import { InlineAlert } from "@/components/common/inline-alert"
import { Panel, PanelBody, PanelHeader, PanelTitle } from "@/components/ui/panel"
import { Tag } from "@/components/ui/tag"
import { users as t } from "@/lib/i18n/admin"
import { visibleEquipment, type EquipmentAccess } from "./access-model"

/**
 * Live context of the user form (§8.4 two columns): which equipment this user would see with the admin flag and
 * roles being edited. Same rule as the server (canSeeEquipment).
 */
export function UserVisibilityPanel({ equipment, isAdmin, roleIds, lostReservations = [] }: {
  equipment: EquipmentAccess[]; isAdmin: boolean; roleIds: string[]
  /** Equipment this user has reserved and would stop seeing if the draft is saved (released with cause access-lost). */
  lostReservations?: EquipmentAccess[]
}) {
  const { visible, hidden } = visibleEquipment(equipment, { isAdmin, roleIds })
  const summary = equipment.length === 0 ? t.visibilityNone
    : isAdmin ? t.visibilityAdmin
      : hidden === 0 ? t.visibilityAll(equipment.length) : t.visibilitySome(visible.length, equipment.length)
  return (
    <Panel>
      <PanelHeader>
        <PanelTitle as="h2">{t.visibilityTitle}</PanelTitle>
        {equipment.length ? <span className="font-mono text-data text-muted-foreground tabular-nums">{visible.length}/{equipment.length}</span> : null}
      </PanelHeader>
      <PanelBody className="gap-3">
        <div className="flex flex-col gap-3" aria-live="polite">
          <p className="text-body text-foreground">{summary}</p>
          {lostReservations.length ? (
            <InlineAlert tone="warn">
              <p>{t.visibilityLosesReservation(lostReservations.length)}</p>
              <ul className="mt-1.5 flex flex-wrap gap-1">
                {lostReservations.map((e) => <li key={e.id}><Tag tone="outline" className="text-foreground">{e.name}</Tag></li>)}
              </ul>
            </InlineAlert>
          ) : null}
        </div>
        {equipment.length && !isAdmin ? (
          <ul className="flex max-h-72 flex-col overflow-y-auto rounded-md border bg-muted/40">
            {equipment.map((e) => {
              const on = visible.includes(e)
              return (
                <li key={e.id} className="flex min-h-8 items-center gap-2 border-b px-2.5 py-1 last:border-b-0">
                  {on ? <EyeIcon aria-hidden className="size-3.5 shrink-0 text-foreground" /> : <EyeOffIcon aria-hidden className="size-3.5 shrink-0 text-faint-foreground" />}
                  <span className={on ? "min-w-0 flex-1 truncate text-foreground" : "min-w-0 flex-1 truncate text-faint-foreground"}>{e.name}</span>
                  <span className="sr-only">{on ? t.visibleSr : t.hiddenSr}</span>
                  {e.roleIds.length === 0 ? <Tag tone="outline">{t.visibilityOpen}</Tag> : null}
                </li>
              )
            })}
          </ul>
        ) : null}
        {!isAdmin && hidden > 0 ? <p className="text-meta text-muted-foreground">{t.visibilityHidden(hidden)}</p> : null}
      </PanelBody>
    </Panel>
  )
}
