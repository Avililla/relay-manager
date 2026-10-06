"use client"

import * as React from "react"
import { ChevronDownIcon } from "lucide-react"
import { Label } from "@/components/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { BAUD_RATES, FLOW_CONTROLS, PARITIES, type DataBits, type FlowControl, type LineSettings, type Parity, type StopBits } from "@/lib/contracts/enums"
import { forms } from "@/lib/i18n/shell"
import { cn } from "@/lib/client/cn"

const DATA_BITS: DataBits[] = [5, 6, 7, 8]
const STOP_BITS: StopBits[] = [1, 2]
const PARITY_LETTER: Record<Parity, string> = { none: "N", even: "E", odd: "O", mark: "M", space: "S" }

/** "8N1" plus the flow control when it is not "none". */
export function frameSummary(l: LineSettings): string {
  return `${l.dataBits}${PARITY_LETTER[l.parity]}${l.stopBits}${l.flowControl === "none" ? "" : ` ${l.flowControl === "rtscts" ? "RTS/CTS" : "XON/XOFF"}`}`
}

function MiniSelect<V extends string | number>({ id, label, value, options, onChange, render }: {
  id: string
  label: string
  value: V
  options: readonly V[]
  onChange: (v: V) => void
  render?: (v: V) => string
}) {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id} className="text-meta">{label}</Label>
      <Select value={String(value)} onValueChange={(v) => onChange(options.find((o) => String(o) === v) ?? value)}>
        <SelectTrigger id={id} size="sm"><SelectValue /></SelectTrigger>
        <SelectContent>
          {options.map((o) => <SelectItem key={String(o)} value={String(o)}>{render ? render(o) : String(o)}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  )
}

/**
 * Line settings of a console (§8.8): a baud select plus an "8N1" button that opens data bits, parity, stop bits
 * and flow control. `baudId` and the aria props go to the baud select (label it with FormField or aria-label).
 */
export function LineSettingsField({ value, onChange, invalid, className, baudId, "aria-label": ariaLabel }: {
  value: LineSettings
  onChange: (v: LineSettings) => void
  invalid?: boolean
  className?: string
  baudId?: string
  "aria-label"?: string
}) {
  const id = React.useId()
  return (
    <div className={cn("flex min-w-0 items-stretch gap-1", className)}>
      <Select value={String(value.baudRate)} onValueChange={(v) => onChange({ ...value, baudRate: Number(v) })}>
        <SelectTrigger id={baudId} aria-label={ariaLabel ?? forms.baud} aria-invalid={invalid || undefined} className="w-28 font-mono text-data tabular-nums">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {BAUD_RATES.map((b) => <SelectItem key={b} value={String(b)} className="font-mono text-data tabular-nums">{b}</SelectItem>)}
        </SelectContent>
      </Select>
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={`${forms.lineSettings}: ${frameSummary(value)}`}
            className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md border border-input bg-muted px-2 font-mono text-data text-foreground hover:border-control-border"
          >
            {frameSummary(value)}
            <ChevronDownIcon aria-hidden className="size-3.5 text-muted-foreground" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="grid w-72 grid-cols-2 gap-3">
          <p className="col-span-2 text-body font-medium">{forms.lineSettings}</p>
          <MiniSelect id={`${id}-db`} label={forms.dataBits} value={value.dataBits} options={DATA_BITS} onChange={(v) => onChange({ ...value, dataBits: v })} />
          <MiniSelect id={`${id}-par`} label={forms.parity} value={value.parity} options={PARITIES} onChange={(v) => onChange({ ...value, parity: v })} render={(v) => forms.parityLabels[v]} />
          <MiniSelect id={`${id}-sb`} label={forms.stopBits} value={value.stopBits} options={STOP_BITS} onChange={(v) => onChange({ ...value, stopBits: v })} />
          <MiniSelect id={`${id}-fc`} label={forms.flow} value={value.flowControl} options={FLOW_CONTROLS} onChange={(v: FlowControl) => onChange({ ...value, flowControl: v })} render={(v) => forms.flowLabels[v]} />
        </PopoverContent>
      </Popover>
    </div>
  )
}
