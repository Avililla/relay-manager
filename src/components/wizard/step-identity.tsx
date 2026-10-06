"use client"

import * as React from "react"
import { MultiSelect } from "@/components/common/combobox"
import { FormField, type FieldErrors } from "@/components/common/form-field"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { EquipmentPreviewCard, type PreviewConsole, type PreviewRelay } from "@/components/templates/equipment-preview-card"
import { wizardText as t } from "@/lib/i18n/wizard"
import type { WizardDraft } from "@/lib/wizard/draft"

/** Step 4 (§8.9): name (suggested from the pattern), S/N, description and roles, with the unit preview beside. */
export function StepIdentity({ draft, onChange, errors, roles, pattern, templateName, previewConsoles, previewRelays }: {
  draft: WizardDraft
  onChange: (patch: Partial<WizardDraft>) => void
  errors: FieldErrors
  roles: Array<{ id: string; name: string }>
  pattern: string
  templateName: string | null
  previewConsoles: PreviewConsole[]
  previewRelays: PreviewRelay[]
}) {
  return (
    <div className="grid min-w-0 gap-8 xl:grid-cols-[minmax(0,1fr)_24rem]">
      <div className="flex min-w-0 max-w-2xl flex-col gap-5">
        <FormField label={t.name} name="name" errors={errors} help={t.nameHelp(pattern)} required>
          <Input
            value={draft.name}
            maxLength={60}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => onChange({ name: e.target.value, nameTouched: true })}
          />
        </FormField>
        <FormField label={t.serialNumber} optionalLabel={t.optional} name="serialNumber" errors={errors}>
          <Input value={draft.serialNumber} maxLength={60} autoComplete="off" spellCheck={false} className="font-mono text-data" onChange={(e) => onChange({ serialNumber: e.target.value })} />
        </FormField>
        <FormField label={t.description} optionalLabel={t.optional} name="description" errors={errors}>
          <Textarea value={draft.description} maxLength={500} rows={2} onChange={(e) => onChange({ description: e.target.value })} />
        </FormField>
        <FormField label={t.roles} name="roleIds" errors={errors} help={roles.length ? t.rolesHelp : t.noRoles}>
          {(p) => (
            <MultiSelect
              {...p}
              options={roles.map((r) => ({ value: r.id, label: r.name }))}
              value={draft.roleIds}
              onChange={(roleIds) => onChange({ roleIds })}
              disabled={!roles.length}
            />
          )}
        </FormField>
      </div>
      {/* A group, not an <aside>: a complementary landmark may not sit inside the step's region. */}
      <div role="group" aria-labelledby="wizard-preview-title" className="flex min-w-0 flex-col gap-2 xl:sticky xl:top-4 xl:self-start">
        <h3 id="wizard-preview-title" className="text-meta font-medium text-muted-foreground">{t.previewTitle}</h3>
        <EquipmentPreviewCard name={draft.name.trim()} templateName={templateName} consoles={previewConsoles} relays={previewRelays} />
      </div>
    </div>
  )
}
