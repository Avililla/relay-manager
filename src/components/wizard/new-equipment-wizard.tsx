"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { ArrowLeftIcon, ArrowRightIcon, CheckIcon, LoaderCircleIcon } from "lucide-react"
import { createEquipment } from "@/actions/equipment"
import { ConfirmDialog } from "@/components/common/confirm-dialog"
import { InlineAlert } from "@/components/common/inline-alert"
import { Page, PageHeader } from "@/components/common/page"
import { Stepper, type StepDef } from "@/components/common/stepper"
import { PageMeta } from "@/components/shell/page-meta"
import { Button } from "@/components/ui/button"
import { Kbd, KbdGroup } from "@/components/ui/kbd"
import { useAction } from "@/hooks/use-action"
import { useUnsavedChanges } from "@/hooks/use-unsaved-changes"
import type { WizardDataDTO } from "@/lib/contracts/equipment"
import { nav } from "@/lib/i18n/shell"
import { wizardText as t } from "@/lib/i18n/wizard"
import { clientId } from "@/lib/client/ids"
import {
  applyChoice, applyMapping, assignPort, bindingConflicts, BLANK_NAME_PATTERN, buildCreateInput, choiceLosesWork, emptyDraft, findTemplate,
  isRelayTarget, isWizardDirty, pruneAssignments, remapCreateErrors, STEP, stepForErrors, validateIdentity, validateSlots, WIZARD_STEPS,
  type ConsoleDraft, type RelayAssignment, type RelayDraft, type WizardDraft,
} from "@/lib/wizard/draft"
import { hasErrors, mergeErrors, type FieldErrors } from "@/lib/wizard/field-errors"
import { POPUP_SELECTOR, wizardKeyIntent } from "@/lib/wizard/keyboard"
import { defaultMatchBy, findPort, portShort } from "@/lib/wizard/ports"
import { diffAgainstTemplate } from "@/lib/wizard/template-diff"
import { StepConnections, type ConnectionsState } from "./step-connections"
import { StepIdentity } from "./step-identity"
import { StepReview } from "./step-review"
import { StepSlots } from "./step-slots"
import { StepTemplate } from "./step-template"
import { useLiveSerial } from "./use-live-serial"
import { useRefreshOn } from "./use-refresh-on"
import { AccessesEditor } from "@/components/accesses/accesses-editor"
import { followConsoleRenames, previewPorts, validateAccessDrafts } from "@/lib/accesses/draft"
import { accessUi } from "@/lib/i18n/accesses"

const DATA_EVENTS = ["equipment.changed"] as const
const toTemplateAccessSlotsForDiff = (d: WizardDraft) => d.accesses.map((a) => ({ ...a, targetHost: a.targetHost || null }))
const STEPS: StepDef[] = WIZARD_STEPS.map((id) => ({ id, label: t.steps[id].label, description: t.steps[id].description }))
const IDENTITY_TEXT = { required: t.required, nameTaken: t.nameTaken, tooLong: t.tooLong }
/** The template card that is checked: where focus goes back after the "¿Cambiar de plantilla?" dialog. */
const CHECKED_TEMPLATE = "section[aria-labelledby=wizard-step-title] [role=radio][data-state=checked]"

/**
 * "Nuevo equipo" (§8.9, W2-B): Plantilla → Consolas y relés → Conexiones → Nombre y acceso → Revisión.
 * One draft for the whole flow ("Atrás" keeps it); the slot draft stays apart from the port and board choices;
 * Enter advances from text inputs, Ctrl+Enter from anywhere on the page (a document listener, so it also works
 * with nothing focused or with focus on the footer buttons); leaving with changes asks first.
 */
export function NewEquipmentWizard({ data, initialChoice }: { data: WizardDataDTO; initialChoice: string | null }) {
  const router = useRouter()
  const resolveCable = React.useCallback((name: string) =>
    data.accessContext.labels.find((l) => l.kind === "jtag" && l.name.toLocaleLowerCase("es") === name.toLocaleLowerCase("es"))?.identity ?? null, [data.accessContext.labels])
  const [initialDraft] = React.useState<WizardDraft>(() =>
    initialChoice ? applyChoice(emptyDraft(), initialChoice, data.templates, data.existingNames, () => clientId("slot"), resolveCable) : emptyDraft())
  const [draft, setDraft] = React.useState<WizardDraft>(initialDraft)
  const [step, setStep] = React.useState(0)
  const [validated, setValidated] = React.useState<ReadonlySet<number>>(() => new Set())
  const [server, setServer] = React.useState<{ draft: WizardDraft; errors: FieldErrors; message: string } | null>(null)
  const [conn, setConn] = React.useState<ConnectionsState>({ probe: {}, selectedGroup: null, previewOn: false, notice: null })
  const [showJtag, setShowJtag] = React.useState(!data.hideJtag)
  const [done, setDone] = React.useState(false)
  /** A template card picked while slot, port or channel work would be lost: waits for "Cambiar de plantilla". */
  const [pendingChoice, setPendingChoice] = React.useState<string | null>(null)
  const { snapshot, isNew } = useLiveSerial(data.serial)
  const create = useAction(createEquipment)
  // Port assignments, board channels and existing names change when any equipment is saved.
  useRefreshOn(DATA_EVENTS, () => !done)
  const headingRef = React.useRef<HTMLHeadingElement>(null)
  const firstRender = React.useRef(true)

  const template = findTemplate(data.templates, draft.choice)
  const dirty = !done && isWizardDirty(draft, initialDraft)
  useUnsavedChanges(dirty)

  const stepErrors = React.useMemo(() => {
    const client = !validated.has(step) ? {}
      : step === STEP.slots ? validateSlots(draft)
        : step === STEP.accesses ? validateAccessDrafts(draft.accesses, draft.consoles.map((c) => c.key))
          : step === STEP.identity ? validateIdentity(draft, data.existingNames, IDENTITY_TEXT) : {}
    const fromServer = server && server.draft === draft ? server.errors : {}
    // A chosen port that another equipment took meanwhile is marked live, before "Crear equipo" (the server still decides).
    const taken = step === STEP.connections || step === STEP.review ? bindingConflicts(draft, snapshot, t.portTakenBy) : {}
    // The live message names the other equipment and says what to do; the server's one for the same row would repeat it.
    const serverRest = Object.fromEntries(Object.entries(fromServer).filter(([k]) => !taken[k]))
    return mergeErrors(client, serverRest, taken)
  }, [validated, step, draft, server, data.existingNames, snapshot])
  const serverMsg = server && server.draft === draft ? server.message : null

  const diff = React.useMemo(() => (template ? diffAgainstTemplate({ ...draft, accesses: toTemplateAccessSlotsForDiff(draft) }, template.spec) : null), [draft, template])

  React.useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false
      return
    }
    headingRef.current?.focus()
  }, [step])

  const update = React.useCallback((patch: Partial<WizardDraft>) => setDraft((d) => ({ ...d, ...patch })), [])

  const goTo = (s: number) => {
    if (step === STEP.connections && s !== STEP.connections) setConn((c) => ({ ...c, previewOn: false }))
    setStep(s)
  }

  const submit = async () => {
    setConn((c) => ({ ...c, previewOn: false }))
    const { input, relayIndex } = buildCreateInput(draft, template)
    const submitted = draft
    const r = await create.run(input)
    if (r.ok) {
      setDone(true)
      toast.success(t.created)
      router.push(`/equipos/${r.data.id}`)
      return
    }
    if (r.error.fieldErrors && hasErrors(r.error.fieldErrors)) {
      const errors = remapCreateErrors(r.error.fieldErrors, relayIndex)
      setServer({ draft: submitted, errors, message: r.error.message })
      // "Asignado en orden: …" no longer holds once the server rejected the mapping: the row error is the only message.
      setConn((c) => ({ ...c, notice: null }))
      const target = stepForErrors(errors)
      if (target !== null && target !== step) goTo(target)
    }
  }

  const goNext = () => {
    if (create.pending || done) return
    if (step === STEP.template && !draft.choice) return
    if (step === STEP.slots || step === STEP.accesses || step === STEP.identity) {
      setValidated((v) => new Set([...v, step]))
      const errs = step === STEP.slots ? validateSlots(draft)
        : step === STEP.accesses ? validateAccessDrafts(draft.accesses, draft.consoles.map((c) => c.key))
          : validateIdentity(draft, data.existingNames, IDENTITY_TEXT)
      if (hasErrors(errs)) {
        requestAnimationFrame(() => document.querySelector<HTMLElement>("[aria-invalid=true]")?.focus())
        return
      }
    }
    if (step === STEP.review) {
      void submit()
      return
    }
    goTo(step + 1)
  }

  // §8.9 keyboard flow on the whole document, not on the step grid: right after load focus is on <body>, and the
  // "Ctrl Intro" hint sits in the footer next to "Siguiente". Dialogs (port picker, unsaved-changes guard, template
  // change) own their keys. preventDefault also stops a focused button (e.g. "Atrás") from activating on the same Enter.
  const onDocumentKeyDown = React.useEffectEvent((e: KeyboardEvent) => {
    const target = e.target instanceof HTMLElement ? e.target : document.body
    if (target.closest("[role=dialog],[role=alertdialog]") || pendingChoice !== null) return
    const intent = wizardKeyIntent({
      key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, shiftKey: e.shiftKey,
      isComposing: e.isComposing, keyCode: e.keyCode,
      target: { tagName: target.tagName, type: target.getAttribute("type"), role: target.getAttribute("role"), inPopup: !!target.closest(POPUP_SELECTOR) },
    })
    if (intent !== "advance") return
    // A plain Enter that a widget already consumed (it called preventDefault) stays with the widget.
    if (e.defaultPrevented && !e.ctrlKey && !e.metaKey) return
    e.preventDefault()
    goNext()
  })
  React.useEffect(() => {
    const h = (e: KeyboardEvent) => onDocumentKeyDown(e)
    document.addEventListener("keydown", h)
    return () => document.removeEventListener("keydown", h)
  }, [])

  const chooseTemplate = (choice: string) => {
    if (choice === draft.choice) return
    if (choiceLosesWork(draft, data.templates, resolveCable)) {
      setPendingChoice(choice)
      return
    }
    setDraft((d) => applyChoice(d, choice, data.templates, data.existingNames, () => clientId("slot"), resolveCable))
  }
  const pendingTemplate = pendingChoice ? findTemplate(data.templates, pendingChoice) : null

  const previewConsoles = draft.consoles.map((c) => {
    const b = draft.bindings[c.uid]
    const p = b ? findPort(snapshot, b.stableKey) : null
    return { key: c.key, label: c.label, line: c.line, adapterShort: p ? portShort(p) : null }
  })
  // A relay without a board channel is not created (it is "Omitido" on the review), so the preview says so too.
  const previewRelays = draft.relays.map((r) => {
    const a = draft.relayTargets[r.uid]
    const board = isRelayTarget(a) ? data.boards.find((b) => b.id === a.boardId) : null
    return { key: r.key, label: r.label, purpose: r.purpose, target: isRelayTarget(a) ? { boardName: board?.name ?? "", channel: a.channel } : null, skipped: !isRelayTarget(a) }
  })

  const heading = t.steps[WIZARD_STEPS[step]]
  const noPorts = snapshot.adapters.length + snapshot.others.length === 0
  const connectionsIntro = draft.consoles.length
    ? noPorts ? t.connectionsIntroNoPorts : t.connectionsIntro
    : draft.relays.length ? t.connectionsIntroRelaysOnly : t.connectionsIntroNothing
  const intro = [t.templateIntro, t.slotsIntro, connectionsIntro, accessUi.stepIntro, t.identityIntro, t.reviewIntro][step]
  const summary = draft.choice
    ? `${template ? template.name : t.blank} · ${t.counts(draft.consoles.length, draft.relays.length)}`
    : undefined

  return (
    <Page className="min-h-full gap-5 pb-0">
      <PageMeta breadcrumbs={[{ label: nav.banco, href: "/" }, { label: t.breadcrumb }]} />
      <PageHeader title={t.pageTitle} summary={summary} />
      {/* The vertical stepper takes 13.5rem + gap: below 1280 px it would squeeze the slot editor and the port columns. */}
      <div className="grid min-w-0 flex-1 content-start gap-6 xl:grid-cols-[13.5rem_minmax(0,1fr)] xl:gap-10">
        <div className="xl:hidden">
          <Stepper steps={STEPS} current={step} orientation="horizontal" aria-label={t.stepsLabel} />
        </div>
        <div className="hidden xl:block">
          <Stepper steps={STEPS} current={step} onStepClick={goTo} className="sticky top-4" aria-label={t.stepsLabel} />
        </div>
        <section aria-labelledby="wizard-step-title" className="flex min-w-0 flex-col gap-5 pb-4">
          <div className="flex flex-col gap-1">
            <h2 id="wizard-step-title" ref={headingRef} tabIndex={-1} className="text-section text-foreground outline-none max-xl:sr-only">{heading.label}</h2>
            <p className="max-w-[72ch] text-meta text-muted-foreground">{intro}</p>
          </div>

          {serverMsg && step !== STEP.review ? <InlineAlert tone="danger" role="alert" title={t.serverErrorsTitle}>{serverMsg}</InlineAlert> : null}

          {step === STEP.template ? (
            <StepTemplate templates={data.templates} value={draft.choice} onChange={chooseTemplate} />
          ) : null}

          {step === STEP.slots ? (
            <StepSlots
              consoles={draft.consoles}
              relays={draft.relays}
              onConsoles={(consoles: ConsoleDraft[]) => setDraft((d) => pruneAssignments({ ...d, consoles, accesses: followConsoleRenames(d.accesses, d.consoles, consoles) }))}
              onRelays={(relays: RelayDraft[]) => setDraft((d) => pruneAssignments({ ...d, relays }))}
              errors={stepErrors}
              provisional={!!template?.needsReview}
            />
          ) : null}

          {step === STEP.connections ? (
            <StepConnections
              draft={draft}
              snapshot={snapshot}
              isNew={isNew}
              hints={data.serialHints}
              showJtag={showJtag}
              onShowJtagChange={setShowJtag}
              boards={data.boards}
              skipInterfaces={template?.spec.skipInterfaces ?? []}
              state={conn}
              onState={(patch) => setConn((c) => ({ ...c, ...patch }))}
              onAssign={(uid, binding) => setDraft((d) => assignPort(d, uid, binding))}
              onMapping={(mapping) => setDraft((d) => applyMapping(d, mapping, (k) => defaultMatchBy(findPort(snapshot, k))))}
              onRelayTarget={(uid, target: RelayAssignment | null) => setDraft((d) => {
                const relayTargets = { ...d.relayTargets }
                if (target) relayTargets[uid] = target
                else delete relayTargets[uid]
                return { ...d, relayTargets }
              })}
              errors={stepErrors}
              cables={{ jtag: data.accessContext.jtag, labels: data.accessContext.labels }}
            />
          ) : null}

          {step === STEP.accesses ? (
            <AccessesEditor
              value={draft.accesses}
              onChange={(accesses) => update({ accesses })}
              mode="equipment"
              errors={stepErrors}
              consoleKeys={draft.consoles.map((c) => c.key)}
              ctx={data.accessContext}
              serial={snapshot}
              equipmentId={null}
            />
          ) : null}

          {step === STEP.identity ? (
            <StepIdentity
              draft={draft}
              onChange={update}
              errors={stepErrors}
              roles={data.roles}
              pattern={template?.spec.namePattern ?? BLANK_NAME_PATTERN}
              templateName={template?.name ?? null}
              previewConsoles={previewConsoles}
              previewRelays={previewRelays}
            />
          ) : null}

          {step === STEP.review ? (
            <StepReview
              draft={draft}
              template={template}
              diff={diff}
              snapshot={snapshot}
              boards={data.boards}
              roles={data.roles}
              errors={stepErrors}
              serverMsg={serverMsg}
              onSaveToTemplate={(saveToTemplate) => update({ saveToTemplate })}
              accessPorts={previewPorts(draft.accesses, data.accessContext)}
              cableName={(serial) => data.accessContext.labels.find((l) => l.kind === "jtag" && l.identity === serial)?.name ?? null}
            />
          ) : null}
        </section>
      </div>

      <div className="sticky bottom-0 z-10 -mx-4 flex items-center gap-3 border-t bg-background px-4 py-3 md:-mx-6 md:px-6">
        <Button variant="ghost" size="lg" onClick={() => goTo(step - 1)} disabled={step === 0 || create.pending}>
          <ArrowLeftIcon aria-hidden />
          {t.back}
        </Button>
        <span className="mr-auto" />
        <span className="hidden items-center gap-1.5 text-meta text-muted-foreground md:inline-flex">
          <KbdGroup><Kbd>Ctrl</Kbd><Kbd>Intro</Kbd></KbdGroup>
          {step === STEP.review ? t.keyboardHintCreate : t.keyboardHint}
        </span>
        {step === STEP.review ? (
          <Button variant="primary" size="lg" onClick={goNext} disabled={create.pending || done} aria-busy={create.pending || undefined}>
            {create.pending ? <LoaderCircleIcon aria-hidden className="animate-spin motion-reduce:hidden" /> : <CheckIcon aria-hidden />}
            {create.pending ? t.creating : t.create}
          </Button>
        ) : (
          <Button variant="primary" size="lg" onClick={goNext} disabled={step === STEP.template && !draft.choice}>
            {t.next}
            <ArrowRightIcon aria-hidden />
          </Button>
        )}
      </div>

      <ConfirmDialog
        open={pendingChoice !== null}
        onOpenChange={(o) => {
          if (o) return
          setPendingChoice(null)
        }}
        // No trigger to return to (the dialog opens from a radio change): back to the checked template card,
        // the old one after "Cancelar", the new one after "Cambiar de plantilla".
        returnFocus={() => document.querySelector<HTMLElement>(CHECKED_TEMPLATE)}
        title={t.changeTemplateTitle}
        description={t.changeTemplateBody(pendingChoice ? pendingTemplate?.name ?? null : null)}
        confirmLabel={t.changeTemplateConfirm}
        onConfirm={() => {
          const choice = pendingChoice
          if (choice) setDraft((d) => applyChoice(d, choice, data.templates, data.existingNames, () => clientId("slot"), resolveCable))
          setPendingChoice(null)
        }}
      />
    </Page>
  )
}

