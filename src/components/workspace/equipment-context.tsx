"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import type { AccessDTO } from "@/lib/contracts/accesses"
import type { ReservationDTO } from "@/lib/contracts/reservations"
import type { ConsoleRuntimeDTO } from "@/lib/contracts/serial"
import type { ServerEvent } from "@/lib/contracts/events"
import type { ViewerDTO } from "@/lib/contracts/users"
import { useServerEvents } from "@/components/providers/events-provider"
import { useShell, useViewer } from "@/components/shell/shell-context"
import { canWriteConsoles, reservationTransition } from "@/components/reservation/reservation-model"
import { reduceAccesses, remoteSessions, type RemoteSession } from "@/components/accesses/access-model"
import { useReservationActions, type ReservationActions } from "@/components/reservation/use-reservation-actions"
import { useLiveState } from "@/hooks/use-live-state"
import { reservation as rt, workspace as t } from "@/lib/i18n/banco"

/** Identity of the unit shown by the workspace layout (a subset of EquipmentWorkspaceDTO). */
export interface EquipmentHeaderData {
  id: string
  name: string
  serialNumber: string | null
  templateName: string | null
  description: string | null
  consoleCount: number
  relayCount: number
  reservation: ReservationDTO | null
  /** For the workspace "⋯" ("Soltar todos los puertos…"); kept live by the header. */
  consoles: Array<{ id: string; key: string; runtime: ConsoleRuntimeDTO }>
  /** Network accesses (live `access.status`): their remote sessions show in the reservation control. */
  accesses: Array<Pick<AccessDTO, "id" | "key" | "label" | "kind" | "policy" | "runtime">>
}

interface EquipmentContextValue {
  equipment: EquipmentHeaderData
  /** Live (SSE `reservation.changed`, reset on every RSC refresh). */
  reservation: ReservationDTO | null
  viewer: ViewerDTO
  warningMin: number
  isHolder: boolean
  /** D24: holder, or an admin while the unit is free (release/retake/clear). */
  canWriteConsoles: boolean
  actions: ReservationActions
  /** Established remote sessions on the accesses (xsdb, nc, ssh…): they keep the reservation alive. */
  sessions: RemoteSession[]
}

const EquipmentContext = React.createContext<EquipmentContextValue | null>(null)

const RESERVATION_EVENTS = ["reservation.changed"] as const
const ACCESS_EVENTS = ["access.status"] as const
const REFRESH_DEBOUNCE_MS = 300

/**
 * Live context of one unit for the workspace layout and its tabs (Consolas, Actividad, Ajustes): the reservation
 * (one source of truth for the header control, the read-only banner and the panes), the reservation actions, the
 * §8.9 toasts after a change, and a debounced `router.refresh()` when the equipment itself changes.
 */
export function EquipmentProvider({ equipment, children }: { equipment: EquipmentHeaderData; children: React.ReactNode }) {
  const router = useRouter()
  const viewer = useViewer()
  const { shell } = useShell()
  // Boxed so that every server render (a new `equipment` object) resets the live value, even when the reservation
  // is null both times: `useLiveState` compares the server value by identity.
  const serverReservation = React.useMemo(() => ({ r: equipment.reservation }), [equipment])
  const reservation = useLiveState(serverReservation, RESERVATION_EVENTS, (s, e) =>
    e.type === "reservation.changed" && e.equipmentId === equipment.id ? { r: e.reservation } : s).r
  const serverAccesses = React.useMemo(() => equipment.accesses, [equipment])
  const accesses = useLiveState(serverAccesses, ACCESS_EVENTS, (s, e) => reduceAccesses(s, e, equipment.id))
  const sessions = React.useMemo(() => remoteSessions(accesses), [accesses])
  const actions = useReservationActions(equipment.id, equipment.name)
  const { reserve } = actions

  // After a forced release the server's own toast already names the admin; the reserve that usually follows it
  // ("Reservar para mí a continuación") needs no second toast.
  const forcedAt = React.useRef(0)
  useServerEvents(RESERVATION_EVENTS, (e: ServerEvent) => {
    if (e.type !== "reservation.changed" || e.equipmentId !== equipment.id) return
    if (e.cause === "force-release" && reservation?.holderId === viewer.id) forcedAt.current = Date.now()
    const tr = reservationTransition(reservation, e, viewer.id)
    if (tr?.kind === "expired") {
      toast.warning(rt.expiredToast, { duration: 10_000, action: { label: rt.reserve, onClick: () => void reserve(null) } })
    } else if (tr?.kind === "reserved-by-other" && Date.now() - forcedAt.current > 10_000) {
      toast.info(rt.reservedByOtherToast(tr.who))
    }
  })

  const refreshTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  useServerEvents(["equipment.changed"], (e) => {
    if (e.type !== "equipment.changed" || e.equipmentId !== equipment.id) return
    if (e.change === "deleted") {
      toast.info(t.equipmentDeleted)
      router.push("/")
      return
    }
    if (refreshTimer.current) clearTimeout(refreshTimer.current)
    refreshTimer.current = setTimeout(() => router.refresh(), REFRESH_DEBOUNCE_MS)
  })
  React.useEffect(() => () => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current)
  }, [])

  const value = React.useMemo<EquipmentContextValue>(() => ({
    equipment,
    reservation,
    viewer,
    warningMin: shell.reservationWarningMin,
    isHolder: !!reservation && reservation.holderId === viewer.id,
    canWriteConsoles: canWriteConsoles(reservation, viewer),
    actions,
    sessions,
  }), [equipment, reservation, viewer, shell.reservationWarningMin, actions, sessions])

  return <EquipmentContext.Provider value={value}>{children}</EquipmentContext.Provider>
}

export function useEquipment(): EquipmentContextValue {
  const c = React.useContext(EquipmentContext)
  if (!c) throw new Error("useEquipment needs <EquipmentProvider>")
  return c
}

/** Optional variant for components that may render outside a workspace. */
export function useOptionalEquipment(): EquipmentContextValue | null {
  return React.useContext(EquipmentContext)
}
