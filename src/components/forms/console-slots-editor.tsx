"use client"

import * as React from "react"
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, Settings2Icon, Trash2Icon } from "lucide-react"
import { errorsFor, errorsUnder, type FieldErrors } from "@/components/common/form-field"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { SimpleTooltip } from "@/components/ui/tooltip"
import { DEFAULT_LINE, ENTER_MODES, type EnterMode, type LineSettings } from "@/lib/contracts/enums"
import { forms } from "@/lib/i18n/shell"
import { cn } from "@/lib/client/cn"
import { LineSettingsField } from "./line-settings-field"
import { moveItem, nextKey, normalizeKey, useRowIds } from "./use-row-ids"

/** The slot fields the editor changes; other fields of a row (id, binding…) are preserved as they are. */
export interface ConsoleSlotFields {
  key: string
  label: string
  line: LineSettings
  enterMode: EnterMode
  localEcho: boolean
  identify: { hostnameRegex?: string; bannerRegex?: string }
  hupcl?: boolean
  captureToDisk?: boolean
}

export function newConsoleSlot(taken: ReadonlyArray<string>, index: number): ConsoleSlotFields {
  return { key: nextKey("CONSOLA", taken), label: `Consola ${index + 1}`, line: { ...DEFAULT_LINE }, enterMode: "cr", localEcho: false, identify: {}, hupcl: false, captureToDisk: true }
}

/**
 * Console slots of a template (`mode="template"`) or an equipment (`mode="equipment"`, adds HUPCL and capture) (§8.8).
 * Rows: key (auto-uppercased), label, line settings, advanced (Intro mode, local echo, identify regexes); add, remove
 * and reorder with buttons. `errors` uses the dotted keys of §7.1 under `errorPrefix` (default "consoles").
 * `renderRowAside(row, i)` renders under a row (the Ajustes binding cell). New rows come from `createRow`.
 */
export function ConsoleSlotsEditor<T extends ConsoleSlotFields>({ value, onChange, mode, errors, errorPrefix = "consoles", renderRowAside, max = 16, createRow, className }: {
  value: T[]
  onChange: (rows: T[]) => void
  mode: "template" | "equipment"
  errors?: FieldErrors
  errorPrefix?: string
  renderRowAside?: (row: T, index: number) => React.ReactNode
  max?: number
  createRow: (index: number, taken: string[]) => T
  className?: string
}) {
  const rows = useRowIds(value.length)
  const baseId = React.useId()
  const update = (i: number, patch: Partial<ConsoleSlotFields>) => onChange(value.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const err = (i: number, field: string) => errorsFor(errors, `${errorPrefix}.${i}.${field}`)

  return (
    <div className={cn("flex min-w-0 flex-col gap-2", className)}>
      {value.length ? (
        <div aria-hidden className="hidden grid-cols-[1.5rem_9rem_minmax(8rem,1fr)_12rem_auto] gap-2 px-2 text-micro text-muted-foreground md:grid">
          <span>#</span><span>{forms.key}</span><span>{forms.label}</span><span>{forms.line}</span><span />
        </div>
      ) : (
        <p className="rounded-lg border border-dashed border-input px-4 py-4 text-body text-muted-foreground">{forms.noConsoles}</p>
      )}
      <ol className="flex flex-col gap-2">
        {value.map((row, i) => {
          const rid = `${baseId}-${i}`
          const rowErrors = errorsUnder(errors, `${errorPrefix}.${i}`)
          const advancedErrors = [...err(i, "identify.hostnameRegex"), ...err(i, "identify.bannerRegex"), ...err(i, "enterMode")]
          return (
            <li key={rows.ids[i]} className={cn("rounded-lg border bg-card", rowErrors.length && "border-danger/60")}>
              <Collapsible defaultOpen={advancedErrors.length > 0}>
                <div className="grid grid-cols-[1.5rem_minmax(0,1fr)] items-center gap-2 p-2 md:grid-cols-[1.5rem_9rem_minmax(8rem,1fr)_12rem_auto]">
                  <span className="font-mono text-data text-faint-foreground tabular-nums">{i + 1}</span>
                  <Input
                    aria-label={`${forms.key} ${i + 1}`}
                    aria-invalid={err(i, "key").length ? true : undefined}
                    value={row.key}
                    onChange={(e) => update(i, { key: normalizeKey(e.target.value) })}
                    spellCheck={false}
                    autoCapitalize="characters"
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
                  <LineSettingsField
                    aria-label={`${forms.baud} ${i + 1}`}
                    value={row.line}
                    invalid={errorsUnder(errors, `${errorPrefix}.${i}.line`).length > 0}
                    onChange={(line) => update(i, { line })}
                    className="max-md:col-start-2"
                  />
                  <div className="flex items-center gap-0.5 max-md:col-start-2">
                    <SimpleTooltip label={forms.advanced}>
                      <CollapsibleTrigger asChild>
                        <Button variant="ghost" size="icon-sm" aria-label={`${forms.advanced}: ${row.key}`} className="data-[state=open]:bg-secondary">
                          <Settings2Icon aria-hidden />
                        </Button>
                      </CollapsibleTrigger>
                    </SimpleTooltip>
                    <Button variant="ghost" size="icon-sm" aria-label={forms.moveUp(row.key)} disabled={i === 0} onClick={() => { rows.move(i, -1); onChange(moveItem(value, i, -1)) }}>
                      <ArrowUpIcon aria-hidden />
                    </Button>
                    <Button variant="ghost" size="icon-sm" aria-label={forms.moveDown(row.key)} disabled={i === value.length - 1} onClick={() => { rows.move(i, 1); onChange(moveItem(value, i, 1)) }}>
                      <ArrowDownIcon aria-hidden />
                    </Button>
                    <Button variant="ghost" size="icon-sm" aria-label={forms.removeRow(row.key)} className="hover:text-danger" onClick={() => { rows.remove(i); onChange(value.filter((_, j) => j !== i)) }}>
                      <Trash2Icon aria-hidden />
                    </Button>
                  </div>
                </div>
                {rowErrors.length ? (
                  <p className="flex flex-col px-2 pb-2 pl-10 text-meta text-danger">{rowErrors.map((m, k) => <span key={k}>{m}</span>)}</p>
                ) : null}
                <CollapsibleContent>
                  <div className="grid gap-3 border-t px-3 py-3 pl-10 md:grid-cols-2">
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor={`${rid}-enter`}>{forms.enterMode}</Label>
                      <Select value={row.enterMode} onValueChange={(v) => update(i, { enterMode: v as EnterMode })}>
                        <SelectTrigger id={`${rid}-enter`} className="w-40 font-mono text-data"><SelectValue /></SelectTrigger>
                        <SelectContent>{ENTER_MODES.map((m) => <SelectItem key={m} value={m} className="font-mono text-data">{forms.enterModes[m]}</SelectItem>)}</SelectContent>
                      </Select>
                    </div>
                    <div className="flex flex-col justify-end gap-2">
                      <div className="flex items-center gap-2">
                        <Checkbox id={`${rid}-echo`} checked={row.localEcho} onCheckedChange={(v) => update(i, { localEcho: v === true })} />
                        <Label htmlFor={`${rid}-echo`} className="font-normal">{forms.localEcho}</Label>
                      </div>
                      {mode === "equipment" ? (
                        <>
                          <div className="flex items-center gap-2">
                            <Checkbox id={`${rid}-hupcl`} checked={!!row.hupcl} onCheckedChange={(v) => update(i, { hupcl: v === true })} />
                            <Label htmlFor={`${rid}-hupcl`} className="font-normal">{forms.hupcl}</Label>
                          </div>
                          <div className="flex items-center gap-2">
                            <Checkbox id={`${rid}-cap`} checked={row.captureToDisk !== false} onCheckedChange={(v) => update(i, { captureToDisk: v === true })} />
                            <Label htmlFor={`${rid}-cap`} className="font-normal">{forms.captureToDisk}</Label>
                          </div>
                        </>
                      ) : null}
                    </div>
                    {(["hostnameRegex", "bannerRegex"] as const).map((f) => (
                      <div key={f} className="flex flex-col gap-1.5">
                        <Label htmlFor={`${rid}-${f}`}>{f === "hostnameRegex" ? forms.hostnameRegex : forms.bannerRegex}</Label>
                        <Input
                          id={`${rid}-${f}`}
                          value={row.identify[f] ?? ""}
                          aria-invalid={err(i, `identify.${f}`).length ? true : undefined}
                          aria-describedby={`${rid}-regex-help`}
                          spellCheck={false}
                          onChange={(e) => update(i, { identify: { ...row.identify, [f]: e.target.value || undefined } })}
                          className="font-mono text-data"
                        />
                      </div>
                    ))}
                    <p id={`${rid}-regex-help`} className="text-meta text-muted-foreground md:col-span-2">{forms.regexHelp}</p>
                  </div>
                </CollapsibleContent>
                {renderRowAside ? <div className="border-t px-3 py-2 pl-10">{renderRowAside(row, i)}</div> : null}
              </Collapsible>
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
          {forms.addConsole}
        </Button>
        {value.length >= max ? <span className="text-meta text-muted-foreground">{forms.maxReached(max)}</span> : null}
      </div>
    </div>
  )
}
