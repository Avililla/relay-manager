"use client"

import * as React from "react"
import { toast } from "sonner"
import { forceReleaseReservation, releaseReservation, renewReservation, reserveEquipment } from "@/actions/reservations"
import { useAction } from "@/hooks/use-action"
import { reservation as t } from "@/lib/i18n/banco"

export interface ReservationActions {
  /** One click (§8.9): `note` null unless the "Reservar con motivo" popover was used. Resolves true on success. */
  reserve(note?: string | null): Promise<boolean>
  /** "Editar motivo": reserving again renews and updates the note (§4.11 rule 3). */
  saveNote(note: string | null): Promise<boolean>
  keep(): Promise<boolean>
  release(): Promise<boolean>
  /** Admin: reason required; optionally reserves right after (checkbox "Reservar para mí a continuación"). */
  forceRelease(reason: string, thenReserve: boolean): Promise<{ ok: boolean; fieldErrors?: Record<string, string[]> }>
  pending: { reserve: boolean; keep: boolean; release: boolean; force: boolean }
}

/**
 * Reservation mutations for one unit, through `useAction` (errors become toasts, a lost session goes to /login).
 * The UI state itself follows `reservation.changed` (SSE) and the RSC refresh the actions trigger: nothing here
 * is optimistic.
 */
export function useReservationActions(equipmentId: string, equipmentName: string): ReservationActions {
  const reserveA = useAction(reserveEquipment)
  const renewA = useAction(renewReservation)
  const releaseA = useAction(releaseReservation)
  const forceA = useAction(forceReleaseReservation)
  const { run: runReserve } = reserveA
  const { run: runRenew } = renewA
  const { run: runRelease } = releaseA
  const { run: runForce } = forceA

  const reserve = React.useCallback(async (note: string | null = null) => {
    const r = await runReserve({ equipmentId, note: note?.trim() ? note.trim() : null })
    if (r.ok) toast.success(t.reserved(equipmentName))
    return r.ok
  }, [runReserve, equipmentId, equipmentName])

  const saveNote = React.useCallback(async (note: string | null) => {
    const r = await runReserve({ equipmentId, note: note?.trim() ? note.trim() : null })
    if (r.ok) toast.success(t.noteSaved)
    return r.ok
  }, [runReserve, equipmentId])

  const keep = React.useCallback(async () => {
    const r = await runRenew({ equipmentId })
    if (r.ok) toast.success(t.kept)
    return r.ok
  }, [runRenew, equipmentId])

  const release = React.useCallback(async () => {
    const r = await runRelease({ equipmentId })
    if (r.ok) toast.success(t.released(equipmentName))
    return r.ok
  }, [runRelease, equipmentId, equipmentName])

  const forceRelease = React.useCallback(async (reason: string, thenReserve: boolean) => {
    const r = await runForce({ equipmentId, reason: reason.trim() })
    if (!r.ok) return { ok: false, fieldErrors: r.error.fieldErrors }
    if (thenReserve) {
      const again = await runReserve({ equipmentId, note: null })
      toast.success(again.ok ? t.forceReleasedAndReserved(equipmentName) : t.forceReleased(equipmentName))
    } else {
      toast.success(t.forceReleased(equipmentName))
    }
    return { ok: true }
  }, [runForce, runReserve, equipmentId, equipmentName])

  const p = { reserve: reserveA.pending, keep: renewA.pending, release: releaseA.pending, force: forceA.pending }
  return React.useMemo(() => ({
    reserve, saveNote, keep, release, forceRelease,
    pending: { reserve: p.reserve, keep: p.keep, release: p.release, force: p.force },
  }), [reserve, saveNote, keep, release, forceRelease, p.reserve, p.keep, p.release, p.force])
}
