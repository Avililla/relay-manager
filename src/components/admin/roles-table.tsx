"use client"

import * as React from "react"
import { AppLink } from "@/components/common/app-link"
import { DataTable, type DataColumn } from "@/components/common/data-table"
import type { RoleDTO } from "@/lib/contracts/users"
import { roles as t } from "@/lib/i18n/admin"

/** Roles list (§8.9): Nombre, Descripción, Usuarios, Equipos. */
export function RolesTable({ rows }: { rows: RoleDTO[] }) {
  const columns = React.useMemo<Array<DataColumn<RoleDTO>>>(() => [
    {
      id: "name", header: t.columns.name, sortValue: (r) => r.name, searchValue: (r) => `${r.name} ${r.description ?? ""}`,
      cell: (r) => <AppLink href={`/roles/${r.id}`} className="font-medium text-foreground underline-offset-4 hover:underline">{r.name}</AppLink>,
      className: "whitespace-nowrap",
    },
    {
      id: "description", header: t.columns.description,
      cell: (r) => r.description
        ? <span className="line-clamp-2 max-w-[56ch] text-muted-foreground">{r.description}</span>
        : <span className="text-faint-foreground">{t.noDescription}</span>,
    },
    {
      id: "users", header: t.columns.users, align: "right", sortValue: (r) => r.userCount, searchValue: (r) => r.users.map((u) => `${u.name} ${u.username}`).join(" "),
      cell: (r) => <span className={r.userCount ? "text-foreground" : "text-faint-foreground"}>{r.userCount}</span>,
    },
    {
      id: "equipment", header: t.columns.equipment, align: "right", sortValue: (r) => r.equipmentCount, searchValue: (r) => r.equipments.map((e) => e.name).join(" "),
      cell: (r) => <span className={r.equipmentCount ? "text-foreground" : "text-faint-foreground"}>{r.equipmentCount}</span>,
    },
  ], [])

  return (
    <DataTable
      rows={rows}
      columns={columns}
      rowKey={(r) => r.id}
      rowHref={(r) => `/roles/${r.id}`}
      search
      searchPlaceholder={t.searchPlaceholder}
      caption={t.caption}
      initialSort={{ id: "name", dir: "asc" }}
    />
  )
}
