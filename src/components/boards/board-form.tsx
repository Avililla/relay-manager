"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { ChevronRightIcon, PlugZapIcon, RadarIcon, TriangleAlertIcon } from "lucide-react"
import { AppLink } from "@/components/common/app-link"
import { FormErrors, FormField } from "@/components/common/form-field"
import { InlineAlert } from "@/components/common/inline-alert"
import { NumberStepper } from "@/components/common/number-stepper"
import { Page, PageHeader } from "@/components/common/page"
import { SaveBar } from "@/components/common/save-bar"
import { Spinner } from "@/components/common/spinner"
import { PageMeta } from "@/components/shell/page-meta"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Panel, PanelBody, PanelDescription, PanelHeader, PanelTitle } from "@/components/ui/panel"
import { RadioCard, RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { useAction } from "@/hooks/use-action"
import { useUnsavedChanges } from "@/hooks/use-unsaved-changes"
import { createBoard, testBoardConnection, updateBoard } from "@/actions/boards"
import { DRIVER_IDS, type DriverId } from "@/lib/contracts/enums"
import type { DetectResultDTO } from "@/lib/contracts/relays"
import { boardForm as t, hardwarePages } from "@/lib/i18n/hardware"
import { driverHelp, tcpPortPlaceholder } from "@/lib/i18n/relays"
import { driverLabel } from "@/lib/i18n/status"
import { cn } from "@/lib/client/cn"
import {
  applyDetect, connectionInput, connectionKey, draftEquals, draftToInput, maxRelays, modelOptions, pulseIsEmulated, setDriver, setModel,
  testGate, usesTcp, type BoardDraft, type ConnectionTest, type FieldErrors,
} from "./board-form-model"
import { DetectResults } from "./detect-results"

const UNKNOWN_MODEL = "__unknown"

export interface BoardFormProps {
  mode: "create" | "edit"
  initial: BoardDraft
  boardId?: string
  boardName?: string
  hasPassword?: boolean
  simulatedAllowed: boolean
  /** `/placas/nueva?desde=<key>`: found (prefilled), missing (the result expired) or none. */
  discovery?: { status: "found"; label: string; test: ConnectionTest | null } | { status: "missing" } | null
}

/**
 * New/edit board form (§8.9): driver radio cards with a Spanish explanation, address and ports, model → relay count,
 * advanced options per driver, and "Probar conexión" with the detect evidence and "Usar estos valores". A
 * non-simulated board must pass the test before its first save.
 */
export function BoardForm({ mode, initial, boardId, boardName, hasPassword = false, simulatedAllowed, discovery = null }: BoardFormProps) {
  const router = useRouter()
  const [draft, setDraft] = React.useState(initial)
  const [test, setTest] = React.useState<ConnectionTest | null>(discovery?.status === "found" ? discovery.test : null)
  const [applied, setApplied] = React.useState<number | null>(null)
  const [localErrors, setLocalErrors] = React.useState<FieldErrors>({})
  const [saved, setSaved] = React.useState(false)
  const [advancedOpen, setAdvancedOpen] = React.useState(
    () => !!(initial.toggleVar || initial.useHttpFallback || initial.transport === "http" || initial.username || hasPassword),
  )
  const testAct = useAction(testBoardConnection)
  const createAct = useAction(createBoard)
  const updateAct = useAction(updateBoard)
  const saving = createAct.pending || updateAct.pending
  const actionErrors = mode === "create" ? createAct.fieldErrors : updateAct.fieldErrors
  const errors = Object.keys(localErrors).length ? localErrors : actionErrors
  const dirty = !draftEquals(draft, initial)
  useUnsavedChanges(dirty && !saved)

  const gate = testGate(mode, draft, test)
  const tcpUsed = usesTcp(draft.driver)
  const models = modelOptions(draft.driver)
  const max = maxRelays(draft)
  const modelInfo = draft.model === null ? null : models.find((m) => m.model === draft.model) ?? null
  const modelKnown = modelInfo !== null

  const update = (patch: Partial<BoardDraft> | ((d: BoardDraft) => BoardDraft)) => {
    setDraft((d) => (typeof patch === "function" ? patch(d) : { ...d, ...patch }))
    setApplied(null)
    if (Object.keys(localErrors).length) setLocalErrors({})
  }

  const runTest = async () => {
    const key = connectionKey(draft)
    const r = await testAct.run(connectionInput(draft))
    if (r.ok) {
      setTest({ key, results: r.data })
      setApplied(null)
    }
  }

  const useResult = (res: DetectResultDTO, index: number) => {
    setDraft((d) => applyDetect(d, res))
    setApplied(index)
    setTest((prev) => (prev ? { ...prev, key: connectionKey(applyDetect(draft, res)) } : prev))
    toast.success(t.valuesApplied)
  }

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault()
    if (saving) return
    const parsed = draftToInput(draft, mode)
    if (!parsed.ok) {
      setLocalErrors(parsed.fieldErrors)
      return
    }
    setLocalErrors({})
    if (mode === "create") {
      if (gate !== "ok") return
      const r = await createAct.run(parsed.input)
      if (r.ok) {
        setSaved(true)
        toast.success(t.created(parsed.input.name))
        router.push(`/placas/${r.data.id}`)
      }
    } else if (boardId) {
      const r = await updateAct.run({ ...parsed.input, boardId })
      if (r.ok) {
        setSaved(true)
        toast.success(t.saved)
        router.push(`/placas/${boardId}`)
      }
    }
  }

  const title = mode === "create" ? t.newTitle : t.editTitle(boardName ?? initial.name)
  const crumbs = mode === "create"
    ? [{ label: hardwarePages.boards, href: "/placas" }, { label: hardwarePages.newBoard }]
    : [{ label: hardwarePages.boards, href: "/placas" }, { label: boardName ?? initial.name, href: `/placas/${boardId}` }, { label: hardwarePages.editBoard }]

  // The test panel already explains an outdated or failed test; the footer only says why "Registrar" is off.
  const gateMessage = gate === "required" ? t.testRequired : gate === "outdated" || gate === "failed" ? t.testGateInvalid : null

  return (
    <Page>
      <PageMeta breadcrumbs={crumbs} />
      <PageHeader title={title} />

      {discovery?.status === "missing" ? (
        <InlineAlert
          tone="warn"
          actions={<Button asChild size="sm"><AppLink href="/descubrimiento?tab=reles"><RadarIcon aria-hidden />{t.staleDiscoveryAction}</AppLink></Button>}
        >
          {t.staleDiscovery}
        </InlineAlert>
      ) : discovery?.status === "found" ? (
        <InlineAlert tone="info">{t.fromDiscovery(discovery.label)}</InlineAlert>
      ) : null}

      <form onSubmit={submit} noValidate className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
        <Panel className="xl:col-start-1 xl:row-start-1">
          <PanelBody className="gap-6">
            <FormField label={t.name} name="name" errors={errors} help={t.nameHelp} required>
              <Input value={draft.name} maxLength={40} autoComplete="off" onChange={(e) => update({ name: e.target.value })} />
            </FormField>

            <fieldset className="flex min-w-0 flex-col gap-2">
              <legend className="mb-2 text-body font-medium text-foreground">{t.driver}</legend>
              <RadioGroup
                value={draft.driver}
                onValueChange={(v) => update((d) => setDriver(d, v as DriverId))}
                className="grid gap-2 sm:grid-cols-2"
                aria-invalid={errors.driver ? true : undefined}
              >
                {DRIVER_IDS.map((d) => {
                  const disabled = d === "simulated" && !simulatedAllowed
                  return (
                    <RadioCard key={d} value={d} disabled={disabled} aria-describedby={`driver-help-${d}`}>
                      <span className="text-body font-semibold text-foreground">{driverLabel(d)}</span>
                      <span id={`driver-help-${d}`} className="text-meta text-muted-foreground">{disabled ? t.driverSimulatedOff : driverHelp(d)}</span>
                    </RadioCard>
                  )
                })}
              </RadioGroup>
              {errors.driver ? <p className="text-meta text-danger">{errors.driver.join(" ")}</p> : null}
              {pulseIsEmulated(draft) ? (
                <p className="flex items-start gap-1.5 text-meta text-muted-foreground">
                  <TriangleAlertIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-warn" />
                  {t.pulseEmulated}
                </p>
              ) : null}
            </fieldset>

            <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_8rem_8rem]">
              <FormField label={t.host} name="host" errors={errors} required>
                <Input value={draft.host} autoComplete="off" spellCheck={false} inputMode="url" className="font-mono text-data" onChange={(e) => update({ host: e.target.value })} />
              </FormField>
              <FormField label={t.httpPort} name="httpPort" errors={errors}>
                <Input value={draft.httpPort} inputMode="numeric" className="font-mono text-data tabular-nums" onChange={(e) => update({ httpPort: e.target.value })} />
              </FormField>
              <FormField label={t.tcpPort} name="tcpPort" errors={errors} help={tcpUsed ? undefined : t.tcpPortUnused}>
                <Input
                  value={tcpUsed ? draft.tcpPort : ""}
                  disabled={!tcpUsed}
                  placeholder={tcpPortPlaceholder(draft.driver)}
                  inputMode="numeric"
                  className="font-mono text-data tabular-nums"
                  onChange={(e) => update({ tcpPort: e.target.value })}
                />
              </FormField>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label={t.model} name="model" errors={errors} help={t.modelHelp}>
                {(p) => (
                  <Select value={modelKnown ? (draft.model ?? UNKNOWN_MODEL) : UNKNOWN_MODEL} onValueChange={(v) => update((d) => setModel(d, v === UNKNOWN_MODEL ? null : v))}>
                    <SelectTrigger {...p} className="w-full"><SelectValue placeholder={t.modelPlaceholder} /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value={UNKNOWN_MODEL}>{draft.model && !modelKnown ? draft.model : t.modelUnknown}</SelectItem>
                      {models.map((m) => (
                        <SelectItem key={m.model} value={m.model}>
                          <span className="font-mono text-data">{m.model}</span>
                          <span className="text-muted-foreground">{` · ${m.relays}`}</span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </FormField>
              <FormField
                label={t.relayCount}
                name="relayCount"
                errors={errors}
                help={modelInfo ? t.relayCountFromModel(modelInfo.model, modelInfo.relays, draft.relayCount) : t.relayCountMax(max)}
              >
                {(p) => <NumberStepper {...p} value={draft.relayCount} min={1} max={max} onChange={(n) => update({ relayCount: n })} className="w-40" />}
              </FormField>
            </div>

            <FormField label={t.mac} name="mac" errors={errors} help={t.macHelp} optionalLabel={t.optional}>
              <Input value={draft.mac} autoComplete="off" spellCheck={false} placeholder="00:04:a3:00:00:00" className="max-w-60 font-mono text-data" onChange={(e) => update({ mac: e.target.value })} />
            </FormField>

            {draft.driver !== "simulated" ? (
              <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen} className="flex flex-col gap-4 border-t pt-4">
                <CollapsibleTrigger asChild>
                  <button type="button" className="-mx-1 flex w-fit items-center gap-1.5 rounded-sm px-1 text-body font-medium text-foreground hover:text-brand">
                    <ChevronRightIcon aria-hidden className={cn("size-4 transition-transform duration-150 ease-(--ease-out) motion-reduce:transition-none", advancedOpen && "rotate-90")} />
                    {t.sectionAdvanced}
                  </button>
                </CollapsibleTrigger>
                <CollapsibleContent className="flex flex-col gap-4">
                  {draft.driver === "devantech-ds-http" || draft.driver === "devantech-ds-ascii" ? (
                    <FormField label={t.toggleVar} name="options.toggleVar" errors={errors} help={t.toggleVarHelp} optionalLabel={t.optional}>
                      <Input value={draft.toggleVar} placeholder="V20944" spellCheck={false} className="max-w-48 font-mono text-data" onChange={(e) => update({ toggleVar: e.target.value.trim() })} />
                    </FormField>
                  ) : null}
                  {draft.driver === "devantech-ds-ascii" ? (
                    <div className="flex items-start gap-2.5">
                      <Checkbox id="http-fallback" checked={draft.useHttpFallback} onCheckedChange={(v) => update({ useHttpFallback: v === true })} aria-describedby="http-fallback-help" className="mt-0.5" />
                      <div className="flex flex-col gap-0.5">
                        <Label htmlFor="http-fallback">{t.httpFallback}</Label>
                        <p id="http-fallback-help" className="text-meta text-muted-foreground">{t.httpFallbackHelp}</p>
                      </div>
                    </div>
                  ) : null}
                  {draft.driver === "devantech-eth" ? (
                    <>
                      <fieldset className="flex flex-col gap-2">
                        <legend className="mb-1 text-body font-medium text-foreground">{t.transport}</legend>
                        <RadioGroup value={draft.transport} onValueChange={(v) => update({ transport: v === "http" ? "http" : "tcp" })} className="gap-1.5">
                          {(["tcp", "http"] as const).map((v) => (
                            <div key={v} className="flex items-center gap-2">
                              <RadioGroupItem id={`transport-${v}`} value={v} />
                              <Label htmlFor={`transport-${v}`} className="font-normal">{v === "tcp" ? t.transportTcp : t.transportHttp}</Label>
                            </div>
                          ))}
                        </RadioGroup>
                      </fieldset>
                      <div className="grid gap-4 sm:grid-cols-2">
                        <FormField label={t.username} name="username" errors={errors} help={t.usernameHelp} optionalLabel={t.optional}>
                          <Input value={draft.username} autoComplete="off" spellCheck={false} onChange={(e) => update({ username: e.target.value })} />
                        </FormField>
                        <FormField
                          label={t.password}
                          name="password"
                          errors={errors}
                          optionalLabel={t.optional}
                          help={draft.clearPassword ? t.passwordWillClear : t.passwordHelp}
                          labelAside={mode === "edit" && hasPassword ? (
                            <Button type="button" variant="link" size="sm" className="text-meta" onClick={() => update({ clearPassword: !draft.clearPassword, password: "" })}>
                              {draft.clearPassword ? t.passwordUndoClear : t.passwordClear}
                            </Button>
                          ) : undefined}
                        >
                          <Input
                            type="password"
                            value={draft.password}
                            disabled={draft.clearPassword}
                            autoComplete="new-password"
                            placeholder={mode === "edit" && hasPassword && !draft.clearPassword ? t.passwordKeep : undefined}
                            onChange={(e) => update({ password: e.target.value })}
                          />
                        </FormField>
                      </div>
                    </>
                  ) : null}
                </CollapsibleContent>
              </Collapsible>
            ) : null}

            <div className="flex items-start gap-3 border-t pt-4">
              <Switch id="board-enabled" checked={draft.enabled} onCheckedChange={(v) => update({ enabled: v })} aria-describedby="board-enabled-help" />
              <div className="flex flex-col gap-0.5">
                <Label htmlFor="board-enabled">{t.enabled}</Label>
                <p id="board-enabled-help" className="text-meta text-muted-foreground">{t.enabledHelp}</p>
              </div>
            </div>

            <FormErrors errors={errors} />
          </PanelBody>
        </Panel>

        {/* On one column the test comes right after the fields and before the save bar: it gates the first save. */}
        <Panel className="xl:sticky xl:top-4 xl:col-start-2 xl:row-span-2 xl:row-start-1">
          <PanelHeader className="flex-col items-start gap-0.5 py-3">
            <PanelTitle>{t.testTitle}</PanelTitle>
            <PanelDescription>{t.testDescription}</PanelDescription>
          </PanelHeader>
          <PanelBody aria-live="polite">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant={mode === "create" && gate !== "ok" ? "primary" : "default"}
                disabled={!draft.host.trim()}
                pending={testAct.pending} onClick={() => void runTest()}
              >
                <PlugZapIcon aria-hidden />
                {testAct.pending ? t.testRunning : t.testRun}
              </Button>
              {testAct.pending ? <Spinner label={t.testRunning} /> : null}
            </div>
            {test && test.key !== connectionKey(draft) ? <InlineAlert tone="warn">{t.testOutdated}</InlineAlert> : null}
            {test ? (
              test.results.length ? (
                <>
                  {test.fromDiscovery ? <p className="text-micro text-muted-foreground">{t.testFromDiscovery}</p> : null}
                  <DetectResults results={test.results} onUse={useResult} appliedIndex={applied} />
                </>
              ) : (
                <InlineAlert tone="warn" title={t.testNone}>{t.testNoneHint}</InlineAlert>
              )
            ) : (
              <p className="text-meta text-muted-foreground">{t.testIdle}</p>
            )}
          </PanelBody>
        </Panel>

        {mode === "create" ? (
          <div className="flex flex-wrap items-center justify-end gap-3 rounded-lg border bg-card px-4 py-3 xl:col-start-1 xl:row-start-2">
            {gateMessage ? <p className="mr-auto text-meta text-muted-foreground">{gateMessage}</p> : null}
            <Button asChild variant="ghost" size="lg"><AppLink href="/placas">{t.cancel}</AppLink></Button>
            <Button type="submit" variant="primary" size="lg" disabled={gate !== "ok"} pending={saving}>
              {saving ? t.creating : t.create}
            </Button>
          </div>
        ) : (
          <SaveBar
            dirty={dirty}
            pending={saving}
            onDiscard={() => { setDraft(initial); setLocalErrors({}) }}
            className="rounded-lg border bg-card xl:col-start-1 xl:row-start-2"
          />
        )}
      </form>
    </Page>
  )
}
