"use client"

import * as React from "react"
import { Section } from "@/components/common/page"
import { InlineAlert } from "@/components/common/inline-alert"
import type { FieldErrors } from "@/components/common/form-field"
import { ConsoleSlotsEditor } from "@/components/forms/console-slots-editor"
import { RelaySlotsEditor } from "@/components/forms/relay-slots-editor"
import { clientId } from "@/lib/client/ids"
import { wizardText as t } from "@/lib/i18n/wizard"
import { newConsoleDraft, newRelayDraft, type ConsoleDraft, type RelayDraft } from "@/lib/wizard/draft"

/** Step 2 (§8.9): the slot draft, prefilled from the template. Keys, labels and line settings; relays optional. */
export function StepSlots({ consoles, relays, onConsoles, onRelays, errors, provisional }: {
  consoles: ConsoleDraft[]
  relays: RelayDraft[]
  onConsoles: (rows: ConsoleDraft[]) => void
  onRelays: (rows: RelayDraft[]) => void
  errors: FieldErrors
  provisional: boolean
}) {
  return (
    <div className="flex flex-col gap-8">
      {provisional ? <InlineAlert tone="info">{t.provisional}</InlineAlert> : null}
      <Section as="h3" title={t.consolesTitle} description={t.consolesCount(consoles.length)}>
        <ConsoleSlotsEditor
          value={consoles}
          onChange={onConsoles}
          mode="equipment"
          errors={errors}
          createRow={(index, taken) => newConsoleDraft(taken, index, clientId("slot"))}
        />
      </Section>
      <Section as="h3" title={t.relaysTitle} description={t.relaysOptional}>
        <RelaySlotsEditor
          value={relays}
          onChange={onRelays}
          mode="equipment"
          errors={errors}
          createRow={(index, taken) => newRelayDraft(taken, index, clientId("relay"))}
        />
      </Section>
    </div>
  )
}
