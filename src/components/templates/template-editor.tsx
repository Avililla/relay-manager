"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { CopyIcon, FileJsonIcon, PlusIcon, Trash2Icon, TriangleAlertIcon } from "lucide-react"
import { createTemplate, deleteTemplate, duplicateTemplate, updateTemplate } from "@/actions/templates"
import { AppLink } from "@/components/common/app-link"
import { ConfirmDialog } from "@/components/common/confirm-dialog"
import { FormErrors, FormField } from "@/components/common/form-field"
import { InlineAlert } from "@/components/common/inline-alert"
import { Page, PageHeader, Section } from "@/components/common/page"
import { SaveBar } from "@/components/common/save-bar"
import { ConsoleSlotsEditor } from "@/components/forms/console-slots-editor"
import { RelaySlotsEditor } from "@/components/forms/relay-slots-editor"
import { AccessesEditor } from "@/components/accesses/accesses-editor"
import { accessUi } from "@/lib/i18n/accesses"
import { PageMeta } from "@/components/shell/page-meta"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Tag } from "@/components/ui/tag"
import { Textarea } from "@/components/ui/textarea"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useAction } from "@/hooks/use-action"
import { useUnsavedChanges } from "@/hooks/use-unsaved-changes"
import { DEFAULT_LINE } from "@/lib/contracts/enums"
import type { TemplateDTO } from "@/lib/contracts/templates"
import { common, nav } from "@/lib/i18n/shell"
import { templateText as t } from "@/lib/i18n/wizard"
import { newConsoleDraft, newRelayDraft } from "@/lib/wizard/draft"
import { hasErrors, mergeErrors } from "@/lib/wizard/field-errors"
import {
  blankTemplateForm, buildTemplateInput, isTemplateDirty, namePreview, templateFormFrom, validateTemplateForm,
  type TemplateConsoleRow, type TemplateForm, type TemplateRelayRow,
} from "@/lib/wizard/template-form"
import { EquipmentPreviewCard } from "./equipment-preview-card"

const INTERFACES = Array.from({ length: 16 }, (_, n) => n)
const letter = (n: number) => String.fromCharCode(65 + n)

/**
 * Template editor (§8.9 Plantillas), for `/plantillas/nueva` (template = null) and `/plantillas/[id]`.
 * Left: identity, name pattern with a live "next name", skipped USB interfaces, console and relay slots, and
 * "Marcar como revisada" for provisional templates. Right: how a new unit will look on the Banco. One SaveBar.
 */
export function TemplateEditor({ template, existingNames }: { template: TemplateDTO | null; existingNames: string[] }) {
  const router = useRouter()
  const [base, setBase] = React.useState(() => ({ version: template?.updatedAt ?? "new", form: template ? templateFormFrom(template) : blankTemplateForm() }))
  const [form, setForm] = React.useState<TemplateForm>(base.form)
  const [showErrors, setShowErrors] = React.useState(false)
  const [conflict, setConflict] = React.useState(false)
  const [leaving, setLeaving] = React.useState(false)
  const [dupOpen, setDupOpen] = React.useState(false)

  /** Defined in a profile file: shown read-only («Duplicar» makes an editable copy). */
  const fromFile = template?.source === "file"
  const sourceFile = template?.sourceFile ?? "plantillas/"
  const dirty = !leaving && !fromFile && isTemplateDirty(form, base.form)

  // A newer server version (our own save after router.refresh, or another admin's): adopt it when the form is
  // clean; otherwise warn and let the user choose.
  if (template && template.updatedAt !== base.version) {
    if (!dirty) {
      const f = templateFormFrom(template)
      setBase({ version: template.updatedAt, form: f })
      setForm(f)
      if (conflict) setConflict(false)
    } else if (!conflict) {
      setConflict(true)
    }
  }

  useUnsavedChanges(dirty)
  const create = useAction(createTemplate)
  const update = useAction(updateTemplate)
  const remove = useAction(deleteTemplate)
  const pending = create.pending || update.pending

  const clientErrors = showErrors ? validateTemplateForm(form) : {}
  const errors = mergeErrors(clientErrors, template ? update.fieldErrors : create.fieldErrors)
  const set = (patch: Partial<TemplateForm>) => setForm((f) => ({ ...f, ...patch }))
  const preview = namePreview(form.namePattern, form.name, existingNames)

  const save = async () => {
    setShowErrors(true)
    if (hasErrors(validateTemplateForm(form))) {
      requestAnimationFrame(() => document.querySelector<HTMLElement>("[aria-invalid=true]")?.focus())
      return
    }
    const input = buildTemplateInput(form)
    if (template) {
      const r = await update.run({ ...input, templateId: template.id, markReviewed: form.markReviewed })
      if (r.ok) {
        toast.success(t.saved)
        setBase((b) => ({ ...b, form }))
        setShowErrors(false)
        router.refresh()
      }
    } else {
      const r = await create.run(input)
      if (r.ok) {
        setLeaving(true)
        toast.success(t.createdToast)
        router.replace(`/plantillas/${r.data.id}`)
      }
    }
  }

  const discard = () => {
    const f = template ? templateFormFrom(template) : blankTemplateForm()
    setBase({ version: template?.updatedAt ?? "new", form: f })
    setForm(f)
    setShowErrors(false)
    setConflict(false)
  }

  const title = template ? template.name : t.newTitle

  return (
    <Page className="pb-0">
      <PageMeta breadcrumbs={[{ label: nav.plantillas, href: "/plantillas" }, { label: title }]} />
      <PageHeader
        title={title}
        summary={template ? (
          <span className="inline-flex flex-wrap items-center gap-2">
            {fromFile ? <Tag tone="neutral" title={t.fileTagTitle(sourceFile)}>{t.fileTag}</Tag> : null}
            {template.retired ? <Tag tone="neutral">{t.retiredTag}</Tag> : null}
            {template.needsReview ? <Tag tone="warn"><TriangleAlertIcon aria-hidden />{t.review}</Tag> : null}
            <span>{template.equipmentCount ? t.usageCount(template.equipmentCount) : t.usageNone}</span>
          </span>
        ) : t.intro}
        actions={template ? (
          <>
            <Button variant="outline" onClick={() => setDupOpen(true)}><CopyIcon aria-hidden />{t.duplicate}</Button>
            {!fromFile || template.retired ? (
              <ConfirmDialog
                trigger={<Button variant="danger-outline"><Trash2Icon aria-hidden />{t.delete}</Button>}
                title={t.deleteTitle(template.name)}
                description={t.deleteDescription(template.equipmentCount)}
                confirmLabel={t.deleteConfirm}
                onConfirm={async () => {
                  const r = await remove.run({ templateId: template.id })
                  if (!r.ok) return false
                  setLeaving(true)
                  toast.success(t.deleted)
                  router.push("/plantillas")
                }}
              />
            ) : null}
          </>
        ) : null}
      />

      {fromFile && template?.retired ? <InlineAlert tone="warn" title={t.retiredTitle}>{t.retiredBody(sourceFile)}</InlineAlert> : null}
      {fromFile && !template?.retired ? <InlineAlert tone="info" icon={FileJsonIcon} title={t.fileTitle(sourceFile)}>{t.fileBody(sourceFile)}</InlineAlert> : null}
      {conflict ? (
        <InlineAlert tone="warn" role="status" actions={<Button size="sm" onClick={discard}>{t.reloadDiscard}</Button>}>
          {t.changedElsewhere}
        </InlineAlert>
      ) : null}
      {template?.needsReview ? <InlineAlert tone="warn" title={t.reviewTitle}>{fromFile ? t.reviewBodyFile(sourceFile) : t.reviewBody}</InlineAlert> : null}

      <div className="grid min-w-0 gap-8 xl:grid-cols-[minmax(0,1fr)_24rem]">
        {/* A file template is read-only: the disabled fieldset disables every control inside. */}
        <fieldset disabled={fromFile} className="flex min-w-0 flex-col gap-8 pb-6">
          <Section title={t.identity}>
            <div className="grid max-w-3xl gap-5 md:grid-cols-2">
              <FormField label={t.name} name="name" errors={errors} required>
                <Input value={form.name} maxLength={40} autoComplete="off" onChange={(e) => set({ name: e.target.value })} />
              </FormField>
              <FormField
                label={t.namePattern}
                name="spec.namePattern"
                errors={errors}
                help={<>{t.namePatternHelp} {preview ? <>{t.nextName} <span className="font-mono text-data text-foreground">{preview}</span></> : t.namePatternInvalid}</>}
              >
                <Input value={form.namePattern} maxLength={40} spellCheck={false} className="font-mono text-data" onChange={(e) => set({ namePattern: e.target.value })} />
              </FormField>
              <FormField label={t.description} optionalLabel={t.optional} name="description" errors={errors} className="md:col-span-2">
                <Textarea value={form.description} maxLength={300} rows={2} onChange={(e) => set({ description: e.target.value })} />
              </FormField>
            </div>
          </Section>

          <Section title={t.consoles} description={t.consolesHelp}>
            <ConsoleSlotsEditor<TemplateConsoleRow>
              value={form.consoles}
              onChange={(consoles) => set({ consoles })}
              mode="template"
              errors={errors}
              errorPrefix="spec.consoles"
              createRow={(index, taken) => {
                const { key, label } = newConsoleDraft(taken, index, "")
                return { key, label, line: { ...DEFAULT_LINE }, enterMode: "cr", localEcho: false, identify: {} }
              }}
            />
          </Section>

          <Section title={t.relays} description={t.relaysHelp}>
            <RelaySlotsEditor<TemplateRelayRow>
              value={form.relays}
              onChange={(relays) => set({ relays })}
              mode="template"
              errors={errors}
              errorPrefix="spec.relays"
              createRow={(index, taken) => {
                const { key, label } = newRelayDraft(taken, index, "")
                return { key, label, purpose: "generic", requireConfirm: false, defaultPulseMs: null }
              }}
            />
          </Section>

          <Section title={accessUi.editorTitle} description={accessUi.templateHelp}>
            <AccessesEditor
              value={form.accesses}
              onChange={(accesses) => set({ accesses })}
              mode="template"
              errors={errors}
              errorPrefix="spec.accesses"
              consoleKeys={form.consoles.map((c) => c.key)}
            />
          </Section>

          <Section title={t.skipTitle} description={t.skipHelp}>
            <div className="flex flex-col gap-1.5">
              <span id="skip-label" className="text-body font-medium text-foreground">{t.skipLabel}</span>
              <ToggleGroup
                type="multiple"
                size="sm"
                aria-labelledby="skip-label"
                value={form.skipInterfaces.map(String)}
                onValueChange={(v) => set({ skipInterfaces: v.map(Number).sort((a, b) => a - b) })}
                className="flex-wrap self-start"
              >
                {INTERFACES.map((n) => (
                  <ToggleGroupItem key={n} value={String(n)} aria-label={t.skipItem(n, letter(n))} className="w-11 gap-1 px-0 font-mono tabular-nums data-[state=on]:bg-brand-tint data-[state=on]:shadow-[inset_0_0_0_1px_var(--brand)]">
                    {n}<span aria-hidden className="text-faint-foreground">{letter(n)}</span>
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </div>
          </Section>

          {template?.needsReview && !fromFile ? (
            <div className="flex max-w-3xl items-start gap-3 rounded-lg border bg-card px-4 py-3">
              <Checkbox id="mark-reviewed" checked={form.markReviewed} onCheckedChange={(v) => set({ markReviewed: v === true })} className="mt-0.5" />
              <div className="flex flex-col gap-0.5">
                <Label htmlFor="mark-reviewed" className="font-medium">{t.markReviewed}</Label>
                <p className="text-meta text-muted-foreground">{t.markReviewedHelp}</p>
              </div>
            </div>
          ) : null}
          <FormErrors errors={errors} className="max-w-3xl" />
        </fieldset>

        <aside aria-label={t.preview} className="flex min-w-0 flex-col gap-6 xl:sticky xl:top-4 xl:self-start">
          <div className="flex flex-col gap-2">
            <h2 className="text-section text-foreground">{t.preview}</h2>
            <EquipmentPreviewCard
              name={preview ?? ""}
              templateName={form.name.trim() || null}
              consoles={form.consoles}
              relays={form.relays}
              caption={t.previewCaption}
            />
          </div>
          {template ? (
            <div className="flex flex-col items-start gap-2">
              <h2 className="text-section text-foreground">{t.usage}</h2>
              <p className="text-meta text-muted-foreground">{template.equipmentCount ? t.usageCount(template.equipmentCount) : t.usageNone}</p>
              {template.retired ? null : (
                <Button asChild variant="outline">
                  <AppLink href={`/equipos/nuevo?plantilla=${encodeURIComponent(template.id)}`}><PlusIcon aria-hidden />{t.newEquipment}</AppLink>
                </Button>
              )}
            </div>
          ) : null}
        </aside>
      </div>

      {fromFile ? null : <SaveBar
        dirty={dirty}
        pending={pending}
        onSave={() => void save()}
        onDiscard={template ? discard : undefined}
        saveLabel={template ? t.save : t.create}
        className="-mx-4 px-4 md:-mx-6 md:px-6"
      />}

      {template ? (
        <DuplicateDialog
          open={dupOpen}
          onOpenChange={setDupOpen}
          template={template}
          dirty={dirty}
          onDone={(id) => {
            setLeaving(true)
            router.push(`/plantillas/${id}`)
          }}
        />
      ) : null}
    </Page>
  )
}

function DuplicateDialog({ open, onOpenChange, template, dirty, onDone }: {
  open: boolean
  onOpenChange: (o: boolean) => void
  template: TemplateDTO
  dirty: boolean
  onDone: (id: string) => void
}) {
  const [name, setName] = React.useState(t.copyName(template.name).slice(0, 40))
  const dup = useAction(duplicateTemplate, { successMessage: t.duplicated })
  const submit = async () => {
    const r = await dup.run({ templateId: template.id, name: name.trim() })
    if (r.ok) {
      onOpenChange(false)
      onDone(r.data.id)
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form
          className="contents"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <DialogHeader>
            <DialogTitle>{t.duplicateTitle}</DialogTitle>
            <DialogDescription>{t.duplicateDescription}</DialogDescription>
          </DialogHeader>
          {dirty ? <InlineAlert tone="info">{t.duplicateDirty}</InlineAlert> : null}
          <FormField label={t.duplicateName} name="name" errors={dup.fieldErrors} required>
            <Input value={name} maxLength={40} autoComplete="off" onChange={(e) => setName(e.target.value)} />
          </FormField>
          <DialogFooter>
            <Button variant="ghost" size="lg" onClick={() => onOpenChange(false)}>{common.cancel}</Button>
            <Button type="submit" variant="primary" size="lg" disabled={!name.trim() || dup.pending}>{t.duplicateConfirm}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
