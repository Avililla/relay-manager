"use client"

import * as React from "react"
import { LayoutTemplateIcon, PlusIcon, TriangleAlertIcon } from "lucide-react"
import { AppLink } from "@/components/common/app-link"
import { DataTable, type DataColumn } from "@/components/common/data-table"
import { EmptyState } from "@/components/common/empty-state"
import { RelativeTime } from "@/components/common/relative-time"
import { Button } from "@/components/ui/button"
import { Tag } from "@/components/ui/tag"
import type { TemplateDTO } from "@/lib/contracts/templates"
import { templateText as t } from "@/lib/i18n/wizard"

const columns: ReadonlyArray<DataColumn<TemplateDTO>> = [
  {
    id: "name",
    header: t.colName,
    sortValue: (r) => r.name,
    searchValue: (r) => `${r.name} ${r.description ?? ""}`,
    cell: (r) => (
      <span className="flex min-w-0 items-center gap-2">
        <AppLink href={`/plantillas/${r.id}`} className="min-w-0 truncate font-medium text-foreground underline-offset-4 hover:underline">{r.name}</AppLink>
        {r.source === "file" ? <Tag tone="neutral" title={t.fileTagTitle(r.sourceFile ?? "plantillas/")}>{t.fileTag}</Tag> : null}
        {r.retired ? <Tag tone="neutral">{t.retiredTag}</Tag> : null}
        {r.needsReview ? <Tag tone="warn"><TriangleAlertIcon aria-hidden />{t.review}</Tag> : null}
      </span>
    ),
  },
  {
    id: "consoles",
    header: t.colConsoles,
    sortValue: (r) => r.spec.consoles.length,
    searchValue: (r) => r.spec.consoles.map((c) => `${c.key} ${c.label}`).join(" "),
    cell: (r) => (
      <span className="flex min-w-0 items-center gap-2">
        <span className="w-4 shrink-0 text-right tabular-nums">{r.spec.consoles.length}</span>
        <span className="min-w-0 truncate font-mono text-data text-muted-foreground">{r.spec.consoles.map((c) => c.key).join(" ")}</span>
      </span>
    ),
    className: "max-w-80 max-sm:max-w-36",
  },
  {
    id: "relays",
    header: t.colRelays,
    sortValue: (r) => r.spec.relays.length,
    cell: (r) => (r.spec.relays.length ? <span className="tabular-nums">{r.spec.relays.length}</span> : <span className="text-meta text-faint-foreground">{t.noRelays}</span>),
    className: "max-sm:hidden",
    headerClassName: "max-sm:hidden",
  },
  {
    id: "equipment",
    header: t.colEquipment,
    sortValue: (r) => r.equipmentCount,
    align: "right",
    cell: (r) => r.equipmentCount,
    className: "max-sm:hidden",
    headerClassName: "max-sm:hidden",
  },
  {
    id: "updated",
    header: t.colUpdated,
    sortValue: (r) => r.updatedAt,
    cell: (r) => <RelativeTime value={r.updatedAt} className="text-meta text-muted-foreground" />,
    className: "max-md:hidden",
    headerClassName: "max-md:hidden",
  },
]

/** Plantillas list (§8.9): name with "Fichero"/"Retirada"/"Revisar" chips, console keys, relays, equipment, last update. */
export function TemplatesTable({ templates, profilePath }: { templates: TemplateDTO[]; profilePath: string }) {
  if (!templates.length) {
    return (
      <EmptyState
        icon={LayoutTemplateIcon}
        title={t.emptyTitle}
        actions={<Button asChild variant="primary"><AppLink href="/plantillas/nueva"><PlusIcon aria-hidden />{t.newButton}</AppLink></Button>}
      >
        {t.emptyBody(profilePath)}
      </EmptyState>
    )
  }
  return (
    <DataTable
      rows={templates}
      columns={columns}
      rowKey={(r) => r.id}
      rowHref={(r) => `/plantillas/${r.id}`}
      search
      searchPlaceholder={t.searchPlaceholder}
      caption={t.pageTitle}
    />
  )
}
