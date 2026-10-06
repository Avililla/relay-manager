import type { Metadata } from "next"
import { auditFiltersQuery, auditFiltersSearch, parseAuditFilters } from "@/components/audit/audit-filters"
import { AuditView } from "@/components/audit/audit-view"
import type { ComboOption } from "@/components/common/combobox"
import { auditPage, hardwarePages } from "@/lib/i18n/hardware"
import { queryAudit } from "@/server/queries/audit"
import { listEquipmentCards } from "@/server/queries/equipment"
import { getSettings } from "@/server/queries/settings"
import { listUsers } from "@/server/queries/users"
import { requireAdminPage } from "../placas/_lib/require-admin-page"

export const metadata: Metadata = { title: hardwarePages.audit }

/** Auditoría (§8.9, admin): the filters live in the URL and the server renders the first page. */
export default async function AuditoriaPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const filters = parseAuditFilters(await searchParams)
  const user = await requireAdminPage(`/auditoria${auditFiltersSearch(filters)}`)
  const query = auditFiltersQuery(filters, new Date())
  const [page, users, equipment, settings] = await Promise.all([queryAudit(query), listUsers(), listEquipmentCards(user), getSettings()])
  const userOptions: ComboOption[] = users.map((u) => ({
    value: u.id,
    label: u.name || u.username,
    description: `${u.username}${u.disabled ? auditPage.userDisabled : ""}`,
    keywords: [u.username],
  }))
  const equipmentOptions: ComboOption[] = equipment.map((e) => ({
    value: e.id,
    label: e.name,
    description: e.templateName ?? undefined,
    keywords: e.serialNumber ? [e.serialNumber] : undefined,
  }))
  return (
    <AuditView
      filters={filters}
      query={query}
      page={page}
      users={userOptions}
      equipment={equipmentOptions}
      retentionDays={settings.auditRetentionDays}
    />
  )
}
