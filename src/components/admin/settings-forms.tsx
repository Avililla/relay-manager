"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { CircleDotIcon, CirclePauseIcon, CircleSlashIcon, TriangleAlertIcon } from "lucide-react"
import { updateSettings } from "@/actions/settings"
import { PublicBanner } from "@/components/auth/public-banner"
import { FormErrors, FormField } from "@/components/common/form-field"
import { InlineAlert } from "@/components/common/inline-alert"
import { MiddleTruncate } from "@/components/common/middle-truncate"
import { NumberStepper } from "@/components/common/number-stepper"
import { RelativeTime } from "@/components/common/relative-time"
import { SaveBar } from "@/components/common/save-bar"
import { StatusChip } from "@/components/common/status-chip"
import { BrandMark } from "@/components/shell/brand-mark"
import { Input } from "@/components/ui/input"
import { Panel, PanelBody, PanelDescription, PanelHeader, PanelTitle } from "@/components/ui/panel"
import { RadioCard, RadioGroup } from "@/components/ui/radio-group"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useAction } from "@/hooks/use-action"
import { useUnsavedChanges } from "@/hooks/use-unsaved-changes"
import type { IsoDate } from "@/lib/contracts/common"
import type { SettingsDTO } from "@/lib/contracts/settings"
import { system as t } from "@/lib/i18n/admin"
import { formatBytes } from "@/lib/i18n/format"
import { cn } from "@/lib/client/cn"
import { mergeFieldErrors, withoutField, type FieldErrors } from "./field-errors"
import { pickSettings, reservationWarningError, settingsDirty, settingsPatch, type SettingsDraft, type SettingsKey } from "./system-model"
import { ToggleField } from "./toggle-field"

// ---------------------------------------------------------------------------------------------------------------
// Shared form state: one partial updateSettings patch per page (§8.9 "each form has a sticky save bar, a dirty
// indicator and a success toast"). After saving, router.refresh() re-renders the shell, titles and other pages.
// ---------------------------------------------------------------------------------------------------------------

function useSettingsForm<K extends SettingsKey>(settings: SettingsDTO, keys: readonly K[], validate?: (d: SettingsDraft<K>) => FieldErrors) {
  const router = useRouter()
  const [base, setBase] = React.useState<SettingsDraft<K>>(() => pickSettings(settings, keys))
  const [draft, setDraft] = React.useState<SettingsDraft<K>>(base)
  const [server, setServer] = React.useState<FieldErrors>({})
  const action = useAction(updateSettings, { successMessage: t.saved })
  const dirty = settingsDirty(base, draft, keys)
  useUnsavedChanges(dirty)
  const local = validate?.(draft) ?? {}
  const errors = mergeFieldErrors(server, local)

  const set = <F extends K>(k: F, v: SettingsDraft<K>[F]) => {
    setDraft((d) => ({ ...d, [k]: v }))
    setServer((x) => withoutField(withoutField(x, k), "_form"))
  }
  // With errors, "Guardar cambios" moves focus to the first invalid field instead of doing nothing.
  const focusFirstInvalid = (form?: HTMLFormElement | null) =>
    requestAnimationFrame(() => form?.querySelector<HTMLElement>("[aria-invalid=true]")?.focus())
  const save = async (form?: HTMLFormElement | null) => {
    if (Object.keys(local).length) {
      focusFirstInvalid(form)
      return
    }
    const r = await action.run(settingsPatch(base, draft, keys))
    if (!r.ok) {
      setServer(r.error.fieldErrors ?? {})
      if (r.error.fieldErrors) focusFirstInvalid(form)
      return
    }
    const next = pickSettings(r.data, keys)
    setBase(next)
    setDraft(next)
    router.refresh()
  }
  const discard = () => {
    setDraft(base)
    setServer({})
  }
  return { draft, set, dirty, errors, pending: action.pending, save, discard }
}

function FormColumns({ children, aside }: { children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="flex min-w-0 flex-col gap-5">{children}</div>
      {aside ? <div className="flex min-w-0 flex-col gap-5 xl:sticky xl:top-5">{aside}</div> : null}
    </div>
  )
}

function Counter({ value, max }: { value: string; max: number }) {
  const n = value.trim().length
  return <span className={cn("text-meta tabular-nums", n > max ? "text-danger" : "text-muted-foreground")}>{t.chars(n, max)}</span>
}

// ---------------------------------------------------------------------------------------------------------------
// General: lab name, banner text, audit retention
// ---------------------------------------------------------------------------------------------------------------

const GENERAL_KEYS = ["labName", "bannerText", "auditRetentionDays"] as const

export function GeneralSettingsForm({ settings }: { settings: SettingsDTO }) {
  const f = useSettingsForm(settings, GENERAL_KEYS, (d): FieldErrors => (d.labName.trim() === "" ? { labName: [t.required] } : {}))
  const banner = (f.draft.bannerText ?? "").trim()
  const labName = f.draft.labName.trim() || settings.labName
  return (
    <form onSubmit={(e) => { e.preventDefault(); void f.save(e.currentTarget) }} noValidate>
      <FormColumns
        aside={(
          <Panel>
            <PanelHeader><PanelTitle as="h2">{t.bannerPreview}</PanelTitle></PanelHeader>
            <PanelBody className="gap-3">
              <div aria-hidden className="overflow-hidden rounded-md border bg-background">
                {banner ? <PublicBanner text={banner} /> : null}
                <div className="flex items-center gap-2.5 px-3 py-2.5">
                  <BrandMark className="size-6" />
                  <span className="min-w-0 truncate text-body font-semibold text-foreground">{labName}</span>
                </div>
              </div>
              <p className="text-meta text-muted-foreground">{banner ? t.bannerPreviewHelp : t.bannerNone}</p>
              <p className="flex flex-col gap-0.5 text-meta text-muted-foreground">
                {t.tabTitle}
                <span className="truncate font-mono text-data text-foreground">{t.tabTitleExample(labName)}</span>
              </p>
            </PanelBody>
          </Panel>
        )}
      >
        <Panel>
          <PanelHeader><PanelTitle as="h2">{t.labSection}</PanelTitle></PanelHeader>
          <PanelBody className="gap-5">
            <FormField label={t.labName} name="labName" errors={f.errors} help={t.labNameHelp} required labelAside={<Counter value={f.draft.labName} max={40} />} className="max-w-xl">
              <Input name="labName" value={f.draft.labName} maxLength={40} onChange={(e) => f.set("labName", e.target.value)} autoComplete="off" />
            </FormField>
            <FormField label={t.bannerText} name="bannerText" errors={f.errors} help={t.bannerHelp} labelAside={<Counter value={f.draft.bannerText ?? ""} max={120} />}>
              <Input name="bannerText" value={f.draft.bannerText ?? ""} maxLength={120} onChange={(e) => f.set("bannerText", e.target.value)} autoComplete="off" />
            </FormField>
          </PanelBody>
        </Panel>
        <Panel>
          <PanelHeader><PanelTitle as="h2">{t.auditSection}</PanelTitle></PanelHeader>
          <PanelBody>
            <FormField label={t.auditRetention} name="auditRetentionDays" errors={f.errors} help={t.auditRetentionHelp}>
              {(p) => <NumberStepper {...p} value={f.draft.auditRetentionDays} onChange={(v) => f.set("auditRetentionDays", v)} min={30} max={3650} step={30} unit={t.days} className="w-48" />}
            </FormField>
          </PanelBody>
        </Panel>
        <FormErrors errors={f.errors} />
        <SaveBar dirty={f.dirty} pending={f.pending} onDiscard={f.discard} />
      </FormColumns>
    </form>
  )
}

// ---------------------------------------------------------------------------------------------------------------
// Reservas: timeout and warning, with a timeline of one reservation
// ---------------------------------------------------------------------------------------------------------------

const RESERVATION_KEYS = ["reservationTimeoutMin", "reservationWarningMin"] as const

function ReservationTimeline({ timeout, warning }: { timeout: number; warning: number }) {
  const valid = warning < timeout && timeout > 0
  const warnPct = valid ? Math.max(3, Math.min(97, (warning / timeout) * 100)) : 0
  return (
    <Panel>
      <PanelHeader><PanelTitle as="h2">{t.timelineTitle}</PanelTitle></PanelHeader>
      <PanelBody className="gap-4">
        <div aria-hidden className="flex flex-col gap-1.5">
          <div className="flex h-2.5 gap-px overflow-hidden rounded-sm bg-secondary">
            <span className="h-full rounded-l-sm bg-brand" style={{ width: `${100 - warnPct}%` }} />
            {valid ? <span className="h-full rounded-r-sm bg-warn" style={{ width: `${warnPct}%` }} /> : null}
          </div>
          <div className="flex justify-between font-mono text-meta text-muted-foreground tabular-nums">
            <span>0</span>
            <span>{timeout} {t.minutes}</span>
          </div>
        </div>
        {valid ? (
          <dl className="flex flex-col gap-1.5 text-meta">
            <div className="flex items-center gap-2">
              <span aria-hidden className="size-2.5 shrink-0 rounded-[2px] bg-brand" />
              <dt className="text-foreground">{t.timelineReserved}</dt>
              <dd className="ml-auto font-mono text-muted-foreground tabular-nums">{t.timelineRange(0, timeout - warning)}</dd>
            </div>
            <div className="flex items-center gap-2">
              <span aria-hidden className="size-2.5 shrink-0 rounded-[2px] bg-warn" />
              <dt className="text-foreground">{t.timelineWarning}</dt>
              <dd className="ml-auto font-mono text-muted-foreground tabular-nums">{t.timelineRange(timeout - warning, timeout)}</dd>
            </div>
          </dl>
        ) : null}
        <p className="text-meta text-muted-foreground text-pretty">{valid ? t.timelineCaption(timeout, warning) : t.warningTooLong}</p>
      </PanelBody>
    </Panel>
  )
}

export function ReservationSettingsForm({ settings }: { settings: SettingsDTO }) {
  const f = useSettingsForm(settings, RESERVATION_KEYS, (d): FieldErrors => {
    const e = reservationWarningError(d.reservationTimeoutMin, d.reservationWarningMin)
    return e ? { reservationWarningMin: [e] } : {}
  })
  return (
    <form onSubmit={(e) => { e.preventDefault(); void f.save(e.currentTarget) }} noValidate>
      <FormColumns aside={<ReservationTimeline timeout={f.draft.reservationTimeoutMin} warning={f.draft.reservationWarningMin} />}>
        <Panel>
          <PanelHeader><PanelTitle as="h2">{t.reservationSection}</PanelTitle></PanelHeader>
          <PanelBody className="grid gap-5 md:grid-cols-2">
            <FormField label={t.reservationTimeout} name="reservationTimeoutMin" errors={f.errors} help={t.reservationTimeoutHelp}>
              {(p) => <NumberStepper {...p} value={f.draft.reservationTimeoutMin} onChange={(v) => f.set("reservationTimeoutMin", v)} min={5} max={480} step={5} unit={t.minutes} className="w-44" />}
            </FormField>
            <FormField label={t.reservationWarning} name="reservationWarningMin" errors={f.errors} help={t.reservationWarningHelp}>
              {(p) => <NumberStepper {...p} value={f.draft.reservationWarningMin} onChange={(v) => f.set("reservationWarningMin", v)} min={1} max={60} unit={t.minutes} className="w-44" />}
            </FormField>
          </PanelBody>
        </Panel>
        <FormErrors errors={f.errors} />
        <SaveBar dirty={f.dirty} pending={f.pending} onDiscard={f.discard} />
      </FormColumns>
    </form>
  )
}

// ---------------------------------------------------------------------------------------------------------------
// Consolas: continuous capture status, retention and input capture
// ---------------------------------------------------------------------------------------------------------------

const CAPTURE_KEYS = ["captureRetentionDays", "captureMaxTotalMb", "captureMaxFileMb", "inputCapture"] as const

export interface CaptureStatusView { dir: string; state: "on" | "off" | "paused-disk"; totalBytes: number; lastPurgeAt: IsoDate | null }

function CaptureStatusPanel({ status }: { status: CaptureStatusView }) {
  const chip = status.state === "on"
    ? <StatusChip tone="neutral" icon={CircleDotIcon} quiet>{t.captureOn}</StatusChip>
    : status.state === "paused-disk"
      ? <StatusChip tone="warn" icon={CirclePauseIcon}>{t.capturePaused}</StatusChip>
      : <StatusChip tone="neutral" icon={CircleSlashIcon} quiet>{t.captureOff}</StatusChip>
  return (
    <Panel>
      <PanelHeader>
        <PanelTitle as="h2">{t.captureStatusSection}</PanelTitle>
      </PanelHeader>
      <PanelBody className="gap-3">
        <PanelDescription>{t.captureStatusHelp}</PanelDescription>
        <dl className="flex flex-col divide-y">
          <div className="flex items-center justify-between gap-3 py-2">
            <dt className="text-meta text-muted-foreground">{t.captureState}</dt>
            <dd className="min-w-0">{chip}</dd>
          </div>
          <div className="flex items-center justify-between gap-3 py-2">
            <dt className="text-meta text-muted-foreground">{t.captureSize}</dt>
            <dd className="font-mono text-data text-foreground tabular-nums">{formatBytes(status.totalBytes)}</dd>
          </div>
          <div className="flex items-center justify-between gap-3 py-2">
            <dt className="text-meta text-muted-foreground">{t.captureLastPurge}</dt>
            <dd className="text-body text-foreground">{status.lastPurgeAt ? <RelativeTime value={status.lastPurgeAt} /> : <span className="text-faint-foreground">{t.captureNever}</span>}</dd>
          </div>
          <div className="flex flex-col gap-1 py-2">
            <dt className="text-meta text-muted-foreground">{t.captureDir}</dt>
            <dd className="min-w-0 text-foreground"><MiddleTruncate value={status.dir} copy copyLabel={t.copyValue(t.captureDir)} tail={24} /></dd>
          </div>
        </dl>
        {status.state === "off" ? <p className="font-mono text-meta text-muted-foreground">{t.captureOffHelp}</p> : null}
      </PanelBody>
    </Panel>
  )
}

export function CaptureSettingsForm({ settings, status }: { settings: SettingsDTO; status: CaptureStatusView }) {
  const f = useSettingsForm(settings, CAPTURE_KEYS)
  const gib = (mb: number) => formatBytes(mb * 1024 * 1024)
  return (
    <form onSubmit={(e) => { e.preventDefault(); void f.save(e.currentTarget) }} noValidate>
      <FormColumns aside={<CaptureStatusPanel status={status} />}>
        {status.state === "paused-disk" ? (
          <InlineAlert tone="warn" icon={CirclePauseIcon} title={t.capturePaused}>{t.capturePausedBody}</InlineAlert>
        ) : null}
        <Panel>
          <PanelHeader><PanelTitle as="h2">{t.retentionSection}</PanelTitle></PanelHeader>
          <PanelBody className="grid gap-5 md:grid-cols-2">
            <FormField label={t.captureRetention} name="captureRetentionDays" errors={f.errors} help={t.captureRetentionHelp}>
              {(p) => <NumberStepper {...p} value={f.draft.captureRetentionDays} onChange={(v) => f.set("captureRetentionDays", v)} min={1} max={3650} unit={t.days} className="w-44" />}
            </FormField>
            <FormField label={t.captureMaxTotal} name="captureMaxTotalMb" errors={f.errors} help={`${t.captureMaxTotalHelp} ${t.equals(gib(f.draft.captureMaxTotalMb))}`}>
              {(p) => <NumberStepper {...p} value={f.draft.captureMaxTotalMb} onChange={(v) => f.set("captureMaxTotalMb", v)} min={100} max={1_000_000} step={1024} unit={t.mb} className="w-52" />}
            </FormField>
            <FormField label={t.captureMaxFile} name="captureMaxFileMb" errors={f.errors} help={t.captureMaxFileHelp}>
              {(p) => <NumberStepper {...p} value={f.draft.captureMaxFileMb} onChange={(v) => f.set("captureMaxFileMb", v)} min={1} max={1024} step={8} unit={t.mb} className="w-44" />}
            </FormField>
          </PanelBody>
        </Panel>
        <Panel>
          <PanelHeader><PanelTitle as="h2">{t.inputSection}</PanelTitle></PanelHeader>
          <PanelBody className="gap-3">
            <RadioGroup
              value={f.draft.inputCapture}
              onValueChange={(v) => f.set("inputCapture", v === "full" ? "full" : "markers")}
              aria-label={t.inputCapture}
              className="grid gap-2 md:grid-cols-2"
            >
              <RadioCard value="markers">
                <span className="text-body font-medium text-foreground">{t.inputMarkers}</span>
                <span className="text-meta text-muted-foreground">{t.inputMarkersHelp}</span>
              </RadioCard>
              <RadioCard value="full">
                <span className="text-body font-medium text-foreground">{t.inputFull}</span>
                <span className="text-meta text-muted-foreground">{t.inputFullHelp}</span>
              </RadioCard>
            </RadioGroup>
            {f.draft.inputCapture === "full" ? (
              <InlineAlert tone="warn" icon={TriangleAlertIcon}>{t.inputFullWarning}</InlineAlert>
            ) : null}
          </PanelBody>
        </Panel>
        <FormErrors errors={f.errors} />
        <SaveBar dirty={f.dirty} pending={f.pending} onDiscard={f.discard} />
      </FormColumns>
    </form>
  )
}

// ---------------------------------------------------------------------------------------------------------------
// Copias: daily backup schedule
// ---------------------------------------------------------------------------------------------------------------

const BACKUP_KEYS = ["backupDailyEnabled", "backupDailyHour", "backupRetentionCount"] as const
const HOURS = Array.from({ length: 24 }, (_, h) => h)

export function BackupSettingsForm({ settings }: { settings: SettingsDTO }) {
  const f = useSettingsForm(settings, BACKUP_KEYS)
  const off = !f.draft.backupDailyEnabled
  return (
    <form onSubmit={(e) => { e.preventDefault(); void f.save(e.currentTarget) }} noValidate>
      <Panel>
        <PanelHeader><PanelTitle as="h2">{t.dailySection}</PanelTitle></PanelHeader>
        <PanelBody className="gap-5">
          <ToggleField label={t.dailyEnabled} description={t.dailyEnabledHelp} checked={f.draft.backupDailyEnabled} onCheckedChange={(v) => f.set("backupDailyEnabled", v)} />
          <div className="grid gap-5 sm:grid-cols-2 lg:max-w-2xl">
            <FormField label={t.dailyHour} name="backupDailyHour" errors={f.errors} help={t.dailyHourHelp}>
              {(p) => (
                <Select value={String(f.draft.backupDailyHour)} onValueChange={(v) => f.set("backupDailyHour", Number(v))} disabled={off}>
                  <SelectTrigger {...p} className="w-32 font-mono text-data tabular-nums"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {HOURS.map((h) => <SelectItem key={h} value={String(h)} className="font-mono text-data tabular-nums">{`${String(h).padStart(2, "0")}:00`}</SelectItem>)}
                  </SelectContent>
                </Select>
              )}
            </FormField>
            <FormField label={t.retentionCount} name="backupRetentionCount" errors={f.errors} help={t.retentionCountHelp}>
              {(p) => <NumberStepper {...p} value={f.draft.backupRetentionCount} onChange={(v) => f.set("backupRetentionCount", v)} min={1} max={365} disabled={off} className="w-40" />}
            </FormField>
          </div>
        </PanelBody>
        <FormErrors errors={f.errors} className="mx-4 mb-3" />
        <SaveBar dirty={f.dirty} pending={f.pending} onDiscard={f.discard} className="rounded-b-lg bg-card" />
      </Panel>
    </form>
  )
}
