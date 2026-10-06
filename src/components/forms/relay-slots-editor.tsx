"use client"

import * as React from "react"
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, Trash2Icon } from "lucide-react"
import { errorsFor, errorsUnder, type FieldErrors } from "@/components/common/form-field"
import { NumberStepper } from "@/components/common/number-stepper"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { RELAY_PURPOSES, type RelayPurpose } from "@/lib/contracts/enums"
import { relayPurposeLabel } from "@/lib/i18n/status"
import { forms } from "@/lib/i18n/shell"
import { cn } from "@/lib/client/cn"
import { moveItem, nextKey, normalizeKey, useRowIds } from "./use-row-ids"

/** Relay slot fields; `key` is nullable on equipment rows (RelayChannelInputSchema). */
export interface RelaySlotFields {
  key: string | null
  label: string
  purpose: RelayPurpose
  requireConfirm: boolean
  defaultPulseMs: number | null
}

export function newRelaySlot(taken: ReadonlyArray<string | null>, index: number): RelaySlotFields {
  return { key: nextKey("RELE", taken), label: `Relé ${index + 1}`, purpose: "generic", requireConfirm: false, defaultPulseMs: null }
}

/**
 * Relay slots (§8.8): key, label, purpose, "Pedir confirmación" and the default pulse. New slots get `RELE_<n>`.
 * With 0 rows: "Sin relés. Los equipos funcionan sin ellos." `renderRowAside` holds the BoardChannelPicker (Ajustes,
 * wizard). Errors use dotted keys under `errorPrefix` (default "relays").
 */
export function RelaySlotsEditor<T extends RelaySlotFields>({ value, onChange, mode, errors, errorPrefix = "relays", renderRowAside, max = 32, createRow, className }: {
  value: T[]
  onChange: (rows: T[]) => void
  mode: "template" | "equipment"
  errors?: FieldErrors
  errorPrefix?: string
  renderRowAside?: (row: T, index: number) => React.ReactNode
  max?: number
  createRow: (index: number, taken: Array<string | null>) => T
  className?: string
}) {
  const rows = useRowIds(value.length)
  const baseId = React.useId()
  const update = (i: number, patch: Partial<RelaySlotFields>) => onChange(value.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const err = (i: number, f: string) => errorsFor(errors, `${errorPrefix}.${i}.${f}`)
  return (
    <div className={cn("flex min-w-0 flex-col gap-2", className)} data-mode={mode}>
      {value.length ? (
        <div aria-hidden className="hidden grid-cols-[1.5rem_8rem_minmax(7rem,1fr)_8.5rem_8.5rem_auto_auto] gap-2 px-2 text-micro text-muted-foreground md:grid">
          <span>#</span><span>{forms.key}</span><span>{forms.label}</span><span>{forms.purpose}</span><span>{forms.defaultPulseMs}</span><span>{forms.confirmShort}</span><span />
        </div>
      ) : (
        <p className="rounded-lg border border-dashed border-input px-4 py-4 text-body text-muted-foreground">{forms.noRelays}</p>
      )}
      <ol className="flex flex-col gap-2">
        {value.map((row, i) => {
          const rid = `${baseId}-${i}`
          const rowErrors = errorsUnder(errors, `${errorPrefix}.${i}`)
          const name = row.key ?? row.label
          return (
            <li key={rows.ids[i]} className={cn("rounded-lg border bg-card", rowErrors.length && "border-danger/60")}>
              <div className="grid grid-cols-[1.5rem_minmax(0,1fr)] items-center gap-2 p-2 md:grid-cols-[1.5rem_8rem_minmax(7rem,1fr)_8.5rem_8.5rem_auto_auto]">
                <span className="font-mono text-data text-faint-foreground tabular-nums">{i + 1}</span>
                <Input
                  aria-label={`${forms.key} ${i + 1}`}
                  aria-invalid={err(i, "key").length ? true : undefined}
                  value={row.key ?? ""}
                  onChange={(e) => update(i, { key: e.target.value ? normalizeKey(e.target.value) : null })}
                  spellCheck={false}
                  className="font-mono text-data"
                />
                <Input
                  aria-label={`${forms.label} ${i + 1}`}
                  aria-invalid={err(i, "label").length ? true : undefined}
                  value={row.label}
                  maxLength={40}
                  onChange={(e) => update(i, { label: e.target.value })}
                  className="max-md:col-start-2"
                />
                <Select value={row.purpose} onValueChange={(v) => update(i, { purpose: v as RelayPurpose })}>
                  <SelectTrigger aria-label={`${forms.purpose} ${i + 1}`} className="max-md:col-start-2"><SelectValue /></SelectTrigger>
                  <SelectContent>{RELAY_PURPOSES.map((p) => <SelectItem key={p} value={p}>{relayPurposeLabel(p)}</SelectItem>)}</SelectContent>
                </Select>
                <NumberStepper
                  aria-label={`${forms.defaultPulseMs} ${i + 1}`}
                  aria-invalid={err(i, "defaultPulseMs").length ? true : undefined}
                  value={row.defaultPulseMs}
                  min={19}
                  max={60000}
                  step={100}
                  placeholder="500"
                  title={forms.defaultPulseHelp}
                  onChange={(v) => update(i, { defaultPulseMs: v })}
                  className="max-md:col-start-2"
                />
                <div className="flex h-8 items-center gap-2 max-md:col-start-2">
                  <Checkbox id={`${rid}-confirm`} checked={row.requireConfirm} onCheckedChange={(v) => update(i, { requireConfirm: v === true })} />
                  <Label htmlFor={`${rid}-confirm`} className="font-normal md:sr-only">{forms.requireConfirm}</Label>
                </div>
                <div className="flex items-center gap-0.5 max-md:col-start-2">
                  <Button variant="ghost" size="icon-sm" aria-label={forms.moveUp(name)} disabled={i === 0} onClick={() => { rows.move(i, -1); onChange(moveItem(value, i, -1)) }}>
                    <ArrowUpIcon aria-hidden />
                  </Button>
                  <Button variant="ghost" size="icon-sm" aria-label={forms.moveDown(name)} disabled={i === value.length - 1} onClick={() => { rows.move(i, 1); onChange(moveItem(value, i, 1)) }}>
                    <ArrowDownIcon aria-hidden />
                  </Button>
                  <Button variant="ghost" size="icon-sm" aria-label={forms.removeRow(name)} className="hover:text-danger" onClick={() => { rows.remove(i); onChange(value.filter((_, j) => j !== i)) }}>
                    <Trash2Icon aria-hidden />
                  </Button>
                </div>
              </div>
              {rowErrors.length ? <p className="flex flex-col px-2 pb-2 pl-10 text-meta text-danger">{rowErrors.map((m, k) => <span key={k}>{m}</span>)}</p> : null}
              {renderRowAside ? <div className="border-t px-3 py-2 pl-10">{renderRowAside(row, i)}</div> : null}
            </li>
          )
        })}
      </ol>
      <div className="flex items-center gap-3">
        <Button
          size="sm"
          disabled={value.length >= max}
          onClick={() => {
            rows.add()
            onChange([...value, createRow(value.length, value.map((r) => r.key))])
          }}
        >
          <PlusIcon aria-hidden />
          {forms.addRelay}
        </Button>
        {value.length >= max ? <span className="text-meta text-muted-foreground">{forms.maxReached(max)}</span> : null}
      </div>
    </div>
  )
}
