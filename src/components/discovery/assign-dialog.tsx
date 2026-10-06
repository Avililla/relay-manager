"use client"

import * as React from "react"
import { toast } from "sonner"
import { LoaderCircleIcon } from "lucide-react"
import { AppLink } from "@/components/common/app-link"
import { Combobox, type ComboOption } from "@/components/common/combobox"
import { FormErrors } from "@/components/common/form-field"
import { InlineAlert } from "@/components/common/inline-alert"
import { suggestedMatchBy } from "@/components/serial/match-by-field"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useAction } from "@/hooks/use-action"
import { updateEquipmentBindings } from "@/actions/equipment"
import type { MatchBy } from "@/lib/contracts/enums"
import type { PortGroup, SerialPortDTO } from "@/lib/contracts/serial"
import { shortName } from "@/lib/i18n/banco"
import { common } from "@/lib/i18n/common"
import { discovery as t } from "@/lib/i18n/hardware"
import { serial as serialText } from "@/lib/i18n/shell"
import {
  allowedMatchBy, assignBindings, initialAssignDraft, isFreePort, portDisplayName, setAssignPort, type AssignConsole, type AssignDraft,
} from "./serial-model"

/** `reservedBy`: the holder's name when someone other than the viewer holds the unit (binding is not reservation-gated, §7). */
export interface AssignEquipment { id: string; name: string; templateName: string | null; consoles: AssignConsole[]; reservedBy?: string | null }

const NONE = "__none"

/**
 * "Asignar a equipo…" (§8.9): choose the equipment, then map the group's free ports onto its consoles without an
 * adapter (suggested in physical order by W1-A's `suggestMapping`), adjust ports and match modes, and save with
 * `updateEquipmentBindings`. Bound consoles are listed but not changed here (that is Ajustes).
 */
export function AssignDialog({ open, onOpenChange, group, single, equipment, returnFocus }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  group: PortGroup
  /** The one-port variant (a row's "Asignar a equipo…"). */
  single: SerialPortDTO | null
  equipment: AssignEquipment[]
  /** Where focus goes when the dialog closes (it has no Radix trigger of its own). */
  returnFocus?: () => HTMLElement | null
}) {
  const [equipmentId, setEquipmentId] = React.useState<string | null>(null)
  const [draft, setDraft] = React.useState<AssignDraft>({})
  const act = useAction(updateEquipmentBindings)
  const selected = equipment.find((e) => e.id === equipmentId) ?? null
  const candidates = group.ports.filter(isFreePort)
  const byKey = new Map(candidates.map((p) => [p.stableKey, p]))
  const groupName = group.adapter ? group.adapter.label : group.label
  const rows = selected ? assignBindings(selected.consoles, draft) : []

  const options: ComboOption[] = equipment.map((e) => {
    const free = e.consoles.filter((c) => !c.bound).length
    return {
      value: e.id,
      label: e.name,
      description: [e.templateName, t.assignConsolesFree(free), e.reservedBy ? t.assignReservedBy(shortName(e.reservedBy)) : null].filter(Boolean).join(" · "),
    }
  })

  const choose = (id: string | null) => {
    setEquipmentId(id)
    const eq = equipment.find((e) => e.id === id)
    setDraft(eq ? initialAssignDraft(eq.consoles, group, suggestedMatchBy) : {})
    act.clearFieldErrors()
  }

  const close = (o: boolean) => {
    if (act.pending) return
    if (!o) {
      setEquipmentId(null)
      setDraft({})
      act.clearFieldErrors()
    }
    onOpenChange(o)
  }

  const submit = async () => {
    if (!selected || !rows.length) return
    const r = await act.run({ equipmentId: selected.id, bindings: rows })
    if (r.ok) {
      toast.success(t.assignDone(selected.name, rows.length))
      close(false)
    }
  }

  const unbound = selected ? selected.consoles.filter((c) => !c.bound) : []

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent
        className="sm:max-w-2xl"
        returnFocus={returnFocus}
      >
        <DialogHeader>
          <DialogTitle>{t.assignTitle}</DialogTitle>
          <DialogDescription>{single ? t.assignDescriptionPort(portDisplayName(single)) : t.assignDescriptionGroup(groupName)}</DialogDescription>
        </DialogHeader>

        {equipment.length === 0 ? (
          <InlineAlert tone="info">{t.assignNoEquipment}</InlineAlert>
        ) : (
          <div className="flex min-w-0 flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="assign-equipment">{t.assignEquipment}</Label>
              <Combobox
                id="assign-equipment"
                options={options}
                value={equipmentId}
                onChange={choose}
                placeholder={t.assignEquipmentPlaceholder}
                searchPlaceholder={t.assignEquipmentSearch}
                emptyText={t.assignEquipmentEmpty}
              />
            </div>

            {selected?.reservedBy ? <InlineAlert tone="warn">{t.assignReservedWarn(selected.reservedBy)}</InlineAlert> : null}
            {selected && candidates.length === 0 ? <InlineAlert tone="warn">{t.assignNoFreePorts}</InlineAlert> : null}
            {selected && selected.consoles.length === 0 ? <InlineAlert tone="info">{t.assignNoConsoles}</InlineAlert> : null}
            {selected && selected.consoles.length > 0 && unbound.length === 0 ? (
              <InlineAlert tone="info" actions={<Button asChild size="sm"><AppLink href={`/equipos/${selected.id}/ajustes`}>{t.assignEditLink}</AppLink></Button>}>
                {t.assignAllBound}
              </InlineAlert>
            ) : null}

            {selected && selected.consoles.length > 0 && unbound.length > 0 && candidates.length > 0 ? (
              <div className="flex flex-col gap-2">
                <p className="text-meta text-muted-foreground">{t.assignSuggested}</p>
                <div role="table" aria-label={t.assignTitle} className="flex flex-col divide-y rounded-lg border">
                  <div role="row" className="hidden grid-cols-[minmax(0,10rem)_minmax(0,1fr)_minmax(0,12rem)] gap-3 bg-secondary/60 px-3 py-2 text-micro text-muted-foreground sm:grid">
                    <span role="columnheader">{t.assignConsole}</span>
                    <span role="columnheader">{t.assignPortCol}</span>
                    <span role="columnheader">{t.assignMatchCol}</span>
                  </div>
                  {selected.consoles.map((c) => {
                    const row = draft[c.id]
                    const port = row?.stableKey ? byKey.get(row.stableKey) ?? null : null
                    const modes: MatchBy[] = port ? allowedMatchBy(port) : ["path"]
                    return (
                      <div role="row" key={c.id} className="grid grid-cols-1 items-center gap-2 px-3 py-2.5 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)_minmax(0,12rem)] sm:gap-3">
                        <div role="cell" className="flex min-w-0 flex-col">
                          <span className="font-mono text-data font-semibold text-foreground">{c.key}</span>
                          {c.label !== c.key ? <span className="truncate text-meta text-muted-foreground">{c.label}</span> : null}
                        </div>
                        {c.bound ? (
                          <div role="cell" className="text-meta text-muted-foreground sm:col-span-2">{t.assignAlreadyBound(c.adapterShort ?? serialText.unassignedShort)}</div>
                        ) : (
                          <>
                            {/* Below sm the column headers are hidden: each select gets its own visible caption. */}
                            <div role="cell" className="flex min-w-0 flex-col gap-1">
                              <span aria-hidden className="text-micro text-muted-foreground sm:hidden">{t.assignPortCol}</span>
                              <Select
                                value={row?.stableKey ?? NONE}
                                onValueChange={(v) => setDraft((d) => setAssignPort(d, c.id, v === NONE ? null : byKey.get(v) ?? null, suggestedMatchBy))}
                              >
                                <SelectTrigger aria-label={`${t.assignPortCol} ${c.key}`} className="w-full font-mono text-data"><SelectValue /></SelectTrigger>
                                <SelectContent>
                                  <SelectItem value={NONE}><span className="font-sans text-body text-muted-foreground">{t.assignKeepUnbound}</span></SelectItem>
                                  {candidates.map((p) => (
                                    <SelectItem key={p.stableKey} value={p.stableKey}>
                                      <span className="font-mono text-data">{portDisplayName(p)}</span>
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </div>
                            <div role="cell" className="flex min-w-0 flex-col gap-1">
                              <span aria-hidden className="text-micro text-muted-foreground sm:hidden">{t.assignMatchCol}</span>
                              <Select
                                value={row?.matchBy ?? "path"}
                                disabled={!port || modes.length < 2}
                                onValueChange={(v) => setDraft((d) => ({ ...d, [c.id]: { stableKey: d[c.id]?.stableKey ?? null, matchBy: v as MatchBy } }))}
                              >
                                <SelectTrigger aria-label={`${t.assignMatchCol} ${c.key}`} className="w-full"><SelectValue /></SelectTrigger>
                                <SelectContent>
                                  {modes.map((m) => <SelectItem key={m} value={m}>{serialText.matchBy[m]}</SelectItem>)}
                                </SelectContent>
                              </Select>
                            </div>
                          </>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            ) : null}
            <FormErrors errors={act.fieldErrors} />
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" size="lg" aria-disabled={act.pending || undefined} onClick={() => close(false)}>{common.cancel}</Button>
          <Button variant="primary" size="lg" disabled={!rows.length} pending={act.pending} onClick={() => void submit()}>
            {act.pending ? <LoaderCircleIcon aria-hidden className="animate-spin motion-reduce:hidden" /> : null}
            {t.assignConfirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
