"use client"

import * as React from "react"
import { BanIcon, CircleCheckIcon, KeyRoundIcon, ShieldCheckIcon } from "lucide-react"
import { AppLink } from "@/components/common/app-link"
import { DataTable, type DataColumn } from "@/components/common/data-table"
import { RelativeTime } from "@/components/common/relative-time"
import { StatusChip, type ChipTone } from "@/components/common/status-chip"
import { Tag } from "@/components/ui/tag"
import type { UserDTO } from "@/lib/contracts/users"
import { users as t } from "@/lib/i18n/admin"
import { USER_STATUS_ORDER, userStatus, type UserStatus } from "./user-model"

const STATUS: Record<UserStatus, { tone: ChipTone; icon: typeof CircleCheckIcon; label: string }> = {
  active: { tone: "ok", icon: CircleCheckIcon, label: t.status.active },
  mustChange: { tone: "warn", icon: KeyRoundIcon, label: t.status.mustChange },
  disabled: { tone: "neutral", icon: BanIcon, label: t.status.disabled },
}

export function UserStatusChip({ user, quiet = true }: { user: Pick<UserDTO, "disabled" | "mustChangePassword">; quiet?: boolean }) {
  const s = STATUS[userStatus(user)]
  return <StatusChip tone={s.tone} icon={s.icon} quiet={quiet}>{s.label}</StatusChip>
}

/** Columns that fold into the Nombre cell below 768 px, so the list (Nombre, Último acceso) fits a phone. */
const WIDE_ONLY = { className: "hidden md:table-cell", headerClassName: "hidden md:table-cell" } as const

function AdminMark() {
  return (
    <span className="inline-flex items-center gap-1 text-meta text-foreground">
      <ShieldCheckIcon aria-hidden className="size-3.5 text-muted-foreground" />
      {t.columns.admin}
    </span>
  )
}

/** Usuarios list (§8.9): Nombre, Usuario, Roles, Administrador, Estado, Último acceso, Reservas activas. */
export function UsersTable({ rows, viewerId }: { rows: UserDTO[]; viewerId: string }) {
  const columns = React.useMemo<Array<DataColumn<UserDTO>>>(() => [
    {
      id: "name", header: t.columns.name,
      sortValue: (u) => u.name, searchValue: (u) => `${u.name} ${u.username} ${u.email ?? ""}`,
      cell: (u) => (
        <span className="flex min-w-0 flex-col gap-1 py-1 md:py-0">
          <span className="flex min-w-0 items-center gap-2">
            <AppLink href={`/usuarios/${u.id}`} className="truncate font-medium text-foreground underline-offset-4 hover:underline">{u.name}</AppLink>
            {u.id === viewerId ? <Tag tone="brand">{t.you}</Tag> : null}
          </span>
          {/* Phones: the hidden Usuario, Roles, Administrador, Estado and Reservas columns fold under the name. */}
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1 md:hidden">
            <span className="font-mono text-data text-muted-foreground">{u.username}</span>
            {u.isAdmin ? <AdminMark /> : null}
            <UserStatusChip user={u} />
            {u.activeReservations ? <span className="text-meta text-foreground tabular-nums">{t.activeReservationsCount(u.activeReservations)}</span> : null}
          </span>
          {u.roles.length ? <span className="text-meta text-muted-foreground md:hidden">{u.roles.map((r) => r.name).join(", ")}</span> : null}
        </span>
      ),
      className: "max-w-72",
    },
    {
      id: "username", header: t.columns.username, sortValue: (u) => u.username, ...WIDE_ONLY,
      cell: (u) => <span className="font-mono text-data text-muted-foreground">{u.username}</span>,
    },
    {
      id: "roles", header: t.columns.roles, sortValue: (u) => u.roles.length, ...WIDE_ONLY, searchValue: (u) => u.roles.map((r) => r.name).join(" "),
      cell: (u) => u.roles.length ? (
        <span className="flex max-w-64 flex-wrap gap-1">
          {u.roles.slice(0, 3).map((r) => <Tag key={r.id}>{r.name}</Tag>)}
          {u.roles.length > 3 ? <Tag tone="outline">+{u.roles.length - 3}</Tag> : null}
        </span>
      ) : <span className="text-meta text-faint-foreground">{t.noRoles}</span>,
    },
    {
      id: "admin", header: t.columns.admin, sortValue: (u) => (u.isAdmin ? 0 : 1), ...WIDE_ONLY,
      cell: (u) => u.isAdmin
        ? <span className="inline-flex items-center gap-1.5 text-foreground"><ShieldCheckIcon aria-hidden className="size-3.5 text-muted-foreground" />{t.adminYes}</span>
        : <span className="text-muted-foreground">{t.adminNo}</span>,
    },
    {
      id: "status", header: t.columns.status, sortValue: (u) => USER_STATUS_ORDER[userStatus(u)], ...WIDE_ONLY,
      cell: (u) => <UserStatusChip user={u} />,
    },
    {
      id: "lastLogin", header: t.columns.lastLogin, sortValue: (u) => (u.lastLoginAt ? Date.parse(u.lastLoginAt) : null),
      cell: (u) => u.lastLoginAt ? <RelativeTime value={u.lastLoginAt} className="text-muted-foreground" /> : <span className="text-faint-foreground">{t.never}</span>,
    },
    {
      id: "reservations", header: t.columns.reservations, align: "right", sortValue: (u) => u.activeReservations, ...WIDE_ONLY,
      cell: (u) => <span className={u.activeReservations ? "text-foreground" : "text-faint-foreground"}>{u.activeReservations}</span>,
    },
  ], [viewerId])

  return (
    <DataTable
      rows={rows}
      columns={columns}
      rowKey={(u) => u.id}
      rowHref={(u) => `/usuarios/${u.id}`}
      search
      searchPlaceholder={t.searchPlaceholder}
      caption={t.caption}
      initialSort={{ id: "name", dir: "asc" }}
    />
  )
}
