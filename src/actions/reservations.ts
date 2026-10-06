"use server"
// Reservation actions (§7.2, W1-C). One click reserves (D24); only the holder renews or releases; admins force-release.
import { revalidatePath } from "next/cache"
import { EquipmentRefInputSchema } from "@/lib/contracts/equipment"
import { ForceReleaseInputSchema, ReserveInputSchema, type ReservationDTO } from "@/lib/contracts/reservations"
import { defineAction, type ActionContext } from "@/server/actions/define-action"
import type { ReservationUser } from "@/server/services/reservations"

function withIp(ctx: ActionContext): ReservationUser {
  return { ...ctx.user, ip: ctx.ip }
}
function refresh(equipmentId: string): void {
  try {
    revalidatePath("/")
    revalidatePath(`/equipos/${equipmentId}`)
  } catch {
    // outside a request scope (tests): nothing to revalidate
  }
}

export const reserveEquipment = defineAction(
  ReserveInputSchema,
  { auth: "user", auditDenied: "reservation.reserve" },
  async function reserveEquipment(input, ctx): Promise<ReservationDTO> {
    const r = await ctx.rt.reservations.reserve(input.equipmentId, withIp(ctx), { note: input.note, ip: ctx.ip })
    refresh(input.equipmentId)
    return r
  },
)

export const renewReservation = defineAction(
  EquipmentRefInputSchema,
  { auth: "user", auditDenied: "reservation.renew" },
  async function renewReservation(input, ctx): Promise<ReservationDTO> {
    const r = await ctx.rt.reservations.renew(input.equipmentId, withIp(ctx), "button")
    refresh(input.equipmentId)
    return r
  },
)

export const releaseReservation = defineAction(
  EquipmentRefInputSchema,
  { auth: "user", auditDenied: "reservation.release" },
  async function releaseReservation(input, ctx): Promise<null> {
    await ctx.rt.reservations.release(input.equipmentId, withIp(ctx))
    refresh(input.equipmentId)
    return null
  },
)

export const forceReleaseReservation = defineAction(
  ForceReleaseInputSchema,
  { auth: "admin" },
  async function forceReleaseReservation(input, ctx): Promise<null> {
    await ctx.rt.reservations.forceRelease(input.equipmentId, withIp(ctx), input.reason)
    refresh(input.equipmentId)
    return null
  },
)
