"use client"

import * as React from "react"
import { Combobox, type ComboOption } from "@/components/common/combobox"
import { DateRangeField } from "@/components/common/date-range-field"
import { SegmentedControl } from "@/components/common/segmented-control"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { AUDIT_CATEGORIES, type AuditCategory, type AuditOutcome } from "@/lib/contracts/audit"
import { auditCategoryLabel, auditOutcomeLabel } from "@/lib/i18n/audit"
import { auditPage as t } from "@/lib/i18n/hardware"
import { cn } from "@/lib/client/cn"
import { localDay, type AuditFilters, type AuditPeriod } from "./audit-filters"

const ALL = "__all"
const OUTCOMES: AuditOutcome[] = ["ok", "denied", "error"]
const PERIODS: ReadonlyArray<{ value: AuditPeriod; label: string }> = [
  { value: "hoy", label: t.periodToday },
  { value: "7d", label: t.period7 },
  { value: "30d", label: t.period30 },
  { value: "todo", label: t.periodAll },
  { value: "custom", label: t.periodCustom },
]

/**
 * Auditoría filter bar (§8.9): period presets or a custom range, category, user, equipment and outcome. Every change
 * becomes the page URL (`onChange` navigates); the server renders the filtered first page.
 */
export function AuditFilterBar({ id, filters, users, equipment, onChange, className }: {
  id?: string
  filters: AuditFilters
  users: ComboOption[]
  equipment: ComboOption[]
  onChange: (next: AuditFilters) => void
  className?: string
}) {
  const categoryId = React.useId()
  const outcomeId = React.useId()
  const userId = React.useId()
  const equipmentId = React.useId()
  const set = (patch: Partial<AuditFilters>) => onChange({ ...filters, ...patch })

  const setPeriod = (period: AuditPeriod) => {
    if (period === "custom") {
      const now = new Date()
      const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6)
      set({ period, from: filters.from ?? localDay(from), to: filters.to ?? localDay(now) })
    } else {
      set({ period, from: null, to: null })
    }
  }

  return (
    // Top-aligned: every caption shares one baseline (the period control is 2 px taller than the selects).
    <div id={id} role="group" aria-label={t.filtersLabel} className={cn("flex flex-wrap items-start gap-x-3 gap-y-3", className)}>
      <div className="flex min-w-0 flex-col gap-1.5">
        <span aria-hidden className="flex items-center gap-1.5 text-body font-medium text-foreground select-none">{t.period}</span>
        <div className="max-w-full overflow-x-auto [scrollbar-width:none]">
          <SegmentedControl<AuditPeriod> aria-label={t.period} value={filters.period} onChange={setPeriod} options={PERIODS} />
        </div>
      </div>

      {filters.period === "custom" ? (
        <DateRangeField
          value={{ from: filters.from, to: filters.to }}
          onChange={(v) => set({ period: "custom", from: v.from, to: v.to })}
        />
      ) : null}

      <div className="flex w-full flex-col gap-1.5 sm:w-44">
        <Label htmlFor={categoryId}>{t.category}</Label>
        <Select value={filters.category ?? ALL} onValueChange={(v) => set({ category: v === ALL ? null : (v as AuditCategory) })}>
          <SelectTrigger id={categoryId} className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t.categoryAll}</SelectItem>
            {AUDIT_CATEGORIES.map((c) => <SelectItem key={c} value={c}>{auditCategoryLabel(c)}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      <div className="flex w-full flex-col gap-1.5 sm:w-52">
        <Label htmlFor={userId}>{t.user}</Label>
        <Combobox
          id={userId}
          options={users}
          value={filters.userId}
          onChange={(v) => set({ userId: v })}
          placeholder={t.userAll}
          searchPlaceholder={t.userSearch}
          clearable
        />
      </div>

      <div className="flex w-full flex-col gap-1.5 sm:w-52">
        <Label htmlFor={equipmentId}>{t.equipment}</Label>
        <Combobox
          id={equipmentId}
          options={equipment}
          value={filters.equipmentId}
          onChange={(v) => set({ equipmentId: v })}
          placeholder={t.equipmentAll}
          searchPlaceholder={t.equipmentSearch}
          clearable
        />
      </div>

      <div className="flex w-full flex-col gap-1.5 sm:w-36">
        <Label htmlFor={outcomeId}>{t.outcome}</Label>
        <Select value={filters.outcome ?? ALL} onValueChange={(v) => set({ outcome: v === ALL ? null : (v as AuditOutcome) })}>
          <SelectTrigger id={outcomeId} className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t.outcomeAll}</SelectItem>
            {OUTCOMES.map((o) => <SelectItem key={o} value={o}>{auditOutcomeLabel(o)}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

    </div>
  )
}
