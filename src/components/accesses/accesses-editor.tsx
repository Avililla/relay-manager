"use client"

import * as React from "react"
import { AlertTriangleIcon, PlusIcon, TagIcon, Trash2Icon } from "lucide-react"
import { errorsFor, errorsUnder, type FieldErrors } from "@/components/common/form-field"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import {
  ACCESS_KINDS, ACCESS_POLICIES, type AccessKind, type AccessPolicy, type AccessEditContextDTO, type CableLabelDTO, type JtagSnapshotDTO,
} from "@/lib/contracts/accesses"
import type { SerialSnapshotDTO } from "@/lib/contracts/serial"
import { cableChoices, newAccessDraft, previewPorts, type AccessDraft, type CableChoice } from "@/lib/accesses/draft"
import { ACCESS_KIND_LABEL, ACCESS_POLICY_HELP, ACCESS_POLICY_LABEL, accessUi as t } from "@/lib/i18n/accesses"
import { cn } from "@/lib/client/cn"
import { clientId } from "@/lib/client/ids"
import { useRowIds } from "@/components/forms/use-row-ids"
import { KIND_ICON } from "./access-bits"
import { LabelCableDialog } from "./label-cable-dialog"
import { SwitchPortField, useLiveSwitchPorts } from "@/components/equipnet/switch-port-field"
import { useLiveCables } from "./use-live-cables"

const NONE = "__none__"
/** Stable empty values: the live-state hooks reset when their server value changes identity. */
const EMPTY_JTAG: JtagSnapshotDTO = { scannedAt: "", cables: [] }
const EMPTY_LABELS: CableLabelDTO[] = []
const normalizeKey = (v: string) => v.toUpperCase().replace(/[^A-Z0-9_]/g, "_").slice(0, 24)

/**
 * Access rows (§ Accesos): kind, key, name, port (empty = next free one, previewed), opening policy, and per kind the
 * JTAG cable (by label), the console, or the Ethernet target. `mode="template"` hides ports, cables and "Activo"
 * (they belong to each unit). Errors use `accesses.<i>.<field>`.
 */
export function AccessesEditor({ value, onChange, mode, errors, errorPrefix = "accesses", consoleKeys, ctx, serial = null, equipmentId = null, className }: {
  value: AccessDraft[]
  onChange: (rows: AccessDraft[]) => void
  mode: "equipment" | "template"
  errors?: FieldErrors
  errorPrefix?: string
  consoleKeys: readonly string[]
  /** Equipment mode: ports, cables and labels. */
  ctx?: AccessEditContextDTO
  /** For labelling USB-serial adapters from the same dialog. */
  serial?: SerialSnapshotDTO | null
  equipmentId?: string | null
  className?: string
}) {
  const rows = useRowIds(value.length)
  const live = useLiveCables(ctx?.jtag ?? EMPTY_JTAG, ctx?.labels ?? EMPTY_LABELS)
  const network = useLiveSwitchPorts(ctx?.network ?? null, equipmentId)
  const [labelFor, setLabelFor] = React.useState<string | null>(null)
  const ports = ctx ? previewPorts(value, ctx) : []
  const update = (i: number, patch: Partial<AccessDraft>) => onChange(value.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const err = (i: number, f: string) => errorsFor(errors, `${errorPrefix}.${i}.${f}`)
  const add = (kind: AccessKind) => {
    rows.add()
    onChange([...value, newAccessDraft(kind, value.map((r) => r.key), clientId("acc"), { switchMode: mode === "template" || !!network?.configured })])
  }
  const equipment = mode === "equipment"
  const grid = equipment
    ? "md:grid-cols-[1.5rem_8.5rem_9rem_minmax(8rem,1fr)_7.5rem_10rem_3.5rem_auto]"
    : "md:grid-cols-[1.5rem_8.5rem_9rem_minmax(8rem,1fr)_10rem_auto]"

  return (
    <div className={cn("flex min-w-0 flex-col gap-2", className)} data-mode={mode}>
      {equipment && ctx && !ctx.hwServer.path && value.some((r) => r.kind === "jtag") ? (
        <p className="flex items-start gap-2 text-meta text-muted-foreground"><AlertTriangleIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-warn" />{t.hwServerMissing}</p>
      ) : null}
      {value.length ? (
        <div aria-hidden className={cn("hidden gap-2 px-2 text-micro text-muted-foreground md:grid", grid)}>
          <span>#</span><span>{t.kind}</span><span>{t.key}</span><span>{t.label}</span>{equipment ? <span>{t.port}</span> : null}<span>{t.policy}</span>{equipment ? <span>{t.enabled}</span> : null}<span />
        </div>
      ) : (
        <p className="rounded-lg border border-dashed border-input px-4 py-4 text-body text-muted-foreground">{t.noAccesses}</p>
      )}
      <ol className="flex flex-col gap-2">
        {value.map((row, i) => {
          const rowErrors = errorsUnder(errors, `${errorPrefix}.${i}`)
          const Icon = KIND_ICON[row.kind]
          const n = i + 1
          return (
            <li key={rows.ids[i]} data-access-row={row.key} className={cn("rounded-lg border bg-card", rowErrors.length && "border-danger/60", !row.enabled && "opacity-80")}>
              <div className={cn("grid grid-cols-[1.5rem_minmax(0,1fr)] items-center gap-2 p-2", grid)}>
                <span className="font-mono text-data text-faint-foreground tabular-nums">{n}</span>
                <Select value={row.kind} onValueChange={(v) => update(i, { kind: v as AccessKind, ...(v === "tcp" && row.targetPort === null ? { targetPort: network?.equipmentPort ?? 22, sshUser: row.sshUser ?? "root", targetMode: mode === "template" || network?.configured ? "switch" : "ip" } : {}) })}>
                  <SelectTrigger aria-label={`${t.kind} ${n}`}><Icon aria-hidden className="size-4 text-muted-foreground" /><SelectValue /></SelectTrigger>
                  <SelectContent>{ACCESS_KINDS.map((k) => <SelectItem key={k} value={k}>{ACCESS_KIND_LABEL[k]}</SelectItem>)}</SelectContent>
                </Select>
                <Input
                  aria-label={`${t.key} ${n}`}
                  aria-invalid={err(i, "key").length ? true : undefined}
                  value={row.key}
                  onChange={(e) => update(i, { key: normalizeKey(e.target.value) })}
                  spellCheck={false}
                  className="font-mono text-data max-md:col-start-2"
                />
                <Input
                  aria-label={`${t.label} ${n}`}
                  aria-invalid={err(i, "label").length ? true : undefined}
                  value={row.label}
                  maxLength={40}
                  onChange={(e) => update(i, { label: e.target.value })}
                  className="max-md:col-start-2"
                />
                {equipment ? (
                  <Input
                    aria-label={`${t.port} ${n}`}
                    aria-invalid={err(i, "port").length ? true : undefined}
                    inputMode="numeric"
                    value={row.port ?? ""}
                    placeholder={t.portAutoShort(ports[i] ?? null)}
                    title={t.portAuto(ports[i] ?? null)}
                    onChange={(e) => {
                      const v = e.target.value.replace(/\D/g, "").slice(0, 5)
                      update(i, { port: v ? Number(v) : null })
                    }}
                    className="font-mono text-data tabular-nums max-md:col-start-2"
                  />
                ) : null}
                <Select value={row.policy} onValueChange={(v) => update(i, { policy: v as AccessPolicy })}>
                  <SelectTrigger aria-label={`${t.policy} ${n}`} title={ACCESS_POLICY_HELP[row.policy]} className="max-md:col-start-2"><SelectValue /></SelectTrigger>
                  <SelectContent>{ACCESS_POLICIES.map((p) => <SelectItem key={p} value={p}>{ACCESS_POLICY_LABEL[p]}</SelectItem>)}</SelectContent>
                </Select>
                {equipment ? (
                  <div className="flex h-8 items-center max-md:col-start-2">
                    <Switch aria-label={`${t.enabled} ${n}`} checked={row.enabled} onCheckedChange={(v) => update(i, { enabled: v })} />
                  </div>
                ) : null}
                <div className="flex items-center max-md:col-start-2">
                  <Button variant="ghost" size="icon-sm" aria-label={t.remove(row.key)} className="hover:text-danger" onClick={() => { rows.remove(i); onChange(value.filter((_, j) => j !== i)) }}>
                    <Trash2Icon aria-hidden />
                  </Button>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2 border-t px-3 py-2 pl-10">
                {row.kind === "jtag" && equipment && ctx ? (
                  <>
                    <CablePicker
                      label={`${t.cable} ${n}`}
                      invalid={err(i, "cableSerial").length > 0 || err(i, "cableName").length > 0}
                      value={row.cableSerial}
                      choices={cableChoices(live, { equipmentId, takenInDraft: value.flatMap((r, j) => (j !== i && r.kind === "jtag" && r.cableSerial ? [r.cableSerial] : [])), current: row.cableSerial })}
                      onChange={(cableSerial) => update(i, { cableSerial })}
                    />
                    <Button variant="link" size="sm" className="px-1" onClick={() => setLabelFor(row.uid)}><TagIcon aria-hidden />{t.labelNewCable}</Button>
                  </>
                ) : null}
                {row.kind === "jtag" && !equipment ? (
                  <Input
                    aria-label={`${t.templateCable} ${n}`}
                    aria-invalid={err(i, "cableName").length ? true : undefined}
                    value={row.cableName ?? ""}
                    placeholder={t.templateCable}
                    maxLength={32}
                    spellCheck={false}
                    onChange={(e) => update(i, { cableName: e.target.value || null })}
                    className="w-64 font-mono text-data"
                  />
                ) : null}
                {row.kind === "serial" ? (
                  <Select value={row.consoleKey ?? NONE} onValueChange={(v) => update(i, { consoleKey: v === NONE ? null : v })} disabled={!consoleKeys.length}>
                    <SelectTrigger aria-label={`${t.console} ${n}`} aria-invalid={err(i, "consoleKey").length ? true : undefined} className="w-56">
                      <SelectValue placeholder={consoleKeys.length ? t.chooseConsole : t.noConsoles} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>{t.chooseConsole}</SelectItem>
                      {consoleKeys.map((k) => <SelectItem key={k} value={k} className="font-mono">{k}</SelectItem>)}
                    </SelectContent>
                  </Select>
                ) : null}
                {row.kind === "tcp" ? (
                  <SwitchPortField
                    value={{ targetMode: row.targetMode, switchPort: row.switchPort, targetHost: row.targetHost, targetPort: row.targetPort, sshUser: row.sshUser }}
                    onChange={(patch) => update(i, patch)}
                    network={network}
                    label={String(n)}
                    mode={mode}
                    invalid={{ port: err(i, "switchPort").length > 0, host: err(i, "targetHost").length > 0, targetPort: err(i, "targetPort").length > 0 }}
                  />
                ) : null}
              </div>
              {rowErrors.length ? <p className="flex flex-col px-2 pb-2 pl-10 text-meta text-danger">{rowErrors.map((m, k) => <span key={k}>{m}</span>)}</p> : null}
            </li>
          )
        })}
      </ol>
      <div className="flex flex-wrap items-center gap-2">
        {ACCESS_KINDS.map((k) => {
          const KIcon = KIND_ICON[k]
          return (
            <Button key={k} size="sm" disabled={value.length >= 16} onClick={() => add(k)}>
              <PlusIcon aria-hidden /><KIcon aria-hidden />
              {k === "jtag" ? t.addJtag : k === "serial" ? t.addSerial : t.addTcp}
            </Button>
          )
        })}
      </div>
      {ctx ? (
        <LabelCableDialog
          open={labelFor !== null}
          onOpenChange={(o) => { if (!o) setLabelFor(null) }}
          kind="jtag"
          lockKind={!serial}
          jtag={live.jtag}
          serial={serial}
          labels={live.labels}
          onLabelled={(l) => {
            if (l.kind !== "jtag" || !labelFor) return
            onChange(value.map((r) => (r.uid === labelFor && !r.cableSerial ? { ...r, cableSerial: l.identity } : r)))
          }}
        />
      ) : null}
    </div>
  )
}

function choiceText(c: CableChoice): string {
  const state = c.takenInDraft ? t.cableInDraft : c.group === "used" ? t.cableUsedBy(c.usedBy.join(", ")) : c.group === "offline" ? t.cableOffline : c.group === "unlabelled" ? t.cableUnlabelled : null
  return state ?? ""
}

/** The JTAG cable of one access: labelled cables by name, grouped (free, used elsewhere, not connected, unlabelled). */
export function CablePicker({ value, onChange, choices, label, invalid }: {
  value: string | null
  onChange: (serial: string | null) => void
  choices: CableChoice[]
  label: string
  invalid?: boolean
}) {
  const groups = (["free", "used", "offline", "unlabelled"] as const).map((g) => ({ g, items: choices.filter((c) => c.group === g) })).filter((x) => x.items.length)
  const current = choices.find((c) => c.serial === value)
  return (
    <Select value={value ?? NONE} onValueChange={(v) => onChange(v === NONE ? null : v)}>
      <SelectTrigger aria-label={label} aria-invalid={invalid ? true : undefined} className="w-72">
        <SelectValue placeholder={t.chooseCable}>
          {current ? (
            <span className="flex min-w-0 items-baseline gap-1.5">
              <span className="truncate">{current.name ?? current.serial}</span>
              {current.name ? <span className="truncate font-mono text-data text-muted-foreground">{current.serial}</span> : null}
              {!current.connected ? <span className="text-meta text-muted-foreground">· {t.cableOffline}</span> : null}
            </span>
          ) : value ? <span className="font-mono text-data">{value}</span> : t.noCable}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>{t.noCable}</SelectItem>
        {groups.map(({ g, items }) => (
          <SelectGroup key={g}>
            <SelectLabel>{t.cableGroups[g]}</SelectLabel>
            {items.map((c) => (
              <SelectItem key={c.serial} value={c.serial} disabled={c.takenInDraft}>
                <span className="flex min-w-0 flex-col">
                  <span className="flex items-baseline gap-1.5">
                    <span className={cn(!c.name && "font-mono text-data")}>{c.name ?? c.serial}</span>
                    {c.name ? <span className="font-mono text-data text-muted-foreground">{c.serial}</span> : null}
                  </span>
                  {choiceText(c) ? <span className="text-micro text-muted-foreground">{choiceText(c)}</span> : null}
                </span>
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  )
}
