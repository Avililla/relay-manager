"use client"

import * as React from "react"
import { FilePlus2Icon, TriangleAlertIcon } from "lucide-react"
import { AppLink } from "@/components/common/app-link"
import { RadioCard, RadioGroup } from "@/components/ui/radio-group"
import { Tag } from "@/components/ui/tag"
import type { TemplateDTO } from "@/lib/contracts/templates"
import { wizardText as t } from "@/lib/i18n/wizard"
import { BLANK } from "@/lib/wizard/draft"

/** Step 1 (§8.9): radio cards for every template, flagged "Revisar" when provisional, then "En blanco". */
export function StepTemplate({ templates, value, onChange }: {
  templates: readonly TemplateDTO[]
  value: string | null
  onChange: (choice: string) => void
}) {
  return (
    <div className="flex flex-col gap-4">
      <RadioGroup
        value={value ?? ""}
        onValueChange={onChange}
        aria-label={t.templateGroup}
        className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-3"
      >
        {templates.map((tpl) => (
          <RadioCard key={tpl.id} value={tpl.id} className="min-h-28 gap-2 p-4">
            <span className="flex w-full min-w-0 items-center gap-2">
              <span className="min-w-0 truncate text-section text-foreground">{tpl.name}</span>
              {tpl.needsReview ? (
                <Tag tone="warn" className="ml-auto" title={t.reviewHint}>
                  <TriangleAlertIcon aria-hidden />
                  {t.review}
                </Tag>
              ) : null}
            </span>
            <span className="text-meta text-muted-foreground tabular-nums">{t.counts(tpl.spec.consoles.length, tpl.spec.relays.length)}</span>
            <span className="flex flex-wrap gap-1">
              {tpl.spec.consoles.length ? tpl.spec.consoles.map((c) => <Tag key={c.key} tone="outline" mono>{c.key}</Tag>) : (
                <span className="text-meta text-faint-foreground">{t.noConsoleKeys}</span>
              )}
            </span>
            {tpl.description ? <span className="line-clamp-2 text-meta text-muted-foreground">{tpl.description}</span> : null}
          </RadioCard>
        ))}
        <RadioCard value={BLANK} className="min-h-28 gap-2 border-dashed p-4">
          <span className="flex items-center gap-2">
            <FilePlus2Icon aria-hidden className="size-4 text-muted-foreground" />
            <span className="text-section text-foreground">{t.blank}</span>
          </span>
          <span className="text-meta text-muted-foreground tabular-nums">{t.counts(0, 0)}</span>
          <span className="text-meta text-muted-foreground">{t.blankDescription}</span>
        </RadioCard>
      </RadioGroup>
      {!templates.length ? (
        <p className="text-meta text-muted-foreground">
          {t.noTemplates} <AppLink href="/plantillas" className="text-brand underline-offset-4 hover:underline">{t.manageTemplates}</AppLink>
        </p>
      ) : null}
    </div>
  )
}
