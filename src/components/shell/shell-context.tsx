"use client"

import * as React from "react"
import type { ServerEvent } from "@/lib/contracts/events"
import type { ShellDTO } from "@/lib/contracts/system"
import type { ViewerDTO } from "@/lib/contracts/users"
import { useLiveState } from "@/hooks/use-live-state"

export interface Breadcrumb { label: string; href?: string }

interface ShellContextValue {
  shell: ShellDTO
  breadcrumbs: Breadcrumb[] | null
  setBreadcrumbs(b: Breadcrumb[] | null): void
}

const ShellContext = React.createContext<ShellContextValue | null>(null)
const ViewerContext = React.createContext<ViewerDTO | null>(null)

const SHELL_EVENTS = ["settings.changed", "reservation.changed"] as const

/** Keeps the shell data live: lab name/banner/warning threshold and the viewer's own reservations. */
function reduceShell(s: ShellDTO, e: ServerEvent): ShellDTO {
  if (e.type === "settings.changed") {
    return { ...s, labName: e.labName, bannerText: e.bannerText, reservationWarningMin: e.reservationWarningMin }
  }
  if (e.type === "reservation.changed") {
    const others = s.myReservations.filter((r) => r.equipmentId !== e.equipmentId)
    const mine = e.reservation && e.reservation.holderId === s.viewer.id
      ? [...others, { equipmentId: e.equipmentId, equipmentName: e.equipmentName, expiresAt: e.reservation.expiresAt }]
      : others
    return mine.length === s.myReservations.length && others.length === s.myReservations.length ? s : { ...s, myReservations: mine }
  }
  return s
}

export function ShellProvider({ shell: serverShell, children }: { shell: ShellDTO; children: React.ReactNode }) {
  const shell = useLiveState(serverShell, SHELL_EVENTS, reduceShell)
  const [breadcrumbs, setBreadcrumbs] = React.useState<Breadcrumb[] | null>(null)
  const value = React.useMemo(() => ({ shell, breadcrumbs, setBreadcrumbs }), [shell, breadcrumbs])
  return (
    <ViewerContext.Provider value={shell.viewer}>
      <ShellContext.Provider value={value}>{children}</ShellContext.Provider>
    </ViewerContext.Provider>
  )
}

export function useShell(): ShellContextValue {
  const c = React.useContext(ShellContext)
  if (!c) throw new Error("useShell needs <ShellProvider>")
  return c
}

/** The signed-in viewer (from the layout's getViewer/getShellData). */
export function useViewer(): ViewerDTO {
  const v = React.useContext(ViewerContext)
  if (!v) throw new Error("useViewer needs <ShellProvider>")
  return v
}

/** Standalone viewer context for trees rendered outside the app shell (tests, demo fixtures). */
export function ViewerProvider({ viewer, children }: { viewer: ViewerDTO; children: React.ReactNode }) {
  return <ViewerContext.Provider value={viewer}>{children}</ViewerContext.Provider>
}
