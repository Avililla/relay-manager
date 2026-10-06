"use server"
// Relay actions (§7.2, W1-B): absolute set and pulse (D33). Order: equipment visible to the user (equipmentForUser,
// D41) → reservation holder → CONFIRMATION_REQUIRED rule → controller (which re-checks the holder and verifies).
import { EquipmentRefInputSchema } from "@/lib/contracts/equipment"
import { PulseRelayInputSchema, SetRelayInputSchema, type RelayChannelStateDTO } from "@/lib/contracts/relays"
import { errorMessage } from "@/lib/i18n/errors"
import { RELAY_TEXT } from "@/lib/i18n/relays"
import { equipmentForUser } from "@/server/access"
import { defineAction, type ActionContext } from "@/server/actions/define-action"
import { DomainError } from "@/server/errors"

async function visibleChannel(ctx: ActionContext, equipmentId: string, channelId: string) {
  const eq = await equipmentForUser(ctx.rt.prisma, ctx.user, equipmentId)
  if (!eq) throw new DomainError("NOT_FOUND", errorMessage("NOT_FOUND"))
  const ch = await ctx.rt.prisma.relayChannel.findUnique({
    where: { id: channelId }, select: { id: true, equipmentId: true, requireConfirm: true },
  })
  if (!ch || ch.equipmentId !== eq.id) throw new DomainError("NOT_FOUND", RELAY_TEXT.errChannelNotFound)
  if (!ctx.rt.reservations.isHolder(eq.id, ctx.user.id)) throw new DomainError("NOT_HOLDER", RELAY_TEXT.errNotHolder)
  return { eq, ch }
}

/** Absolute set. A `requireConfirm` channel needs `confirmed: true` to switch OFF. */
export const setRelay = defineAction(SetRelayInputSchema, { auth: "user", auditDenied: "relay.set" },
  async function setRelay(input, ctx): Promise<RelayChannelStateDTO> {
    const { eq, ch } = await visibleChannel(ctx, input.equipmentId, input.channelId)
    if (ch.requireConfirm && !input.on && !input.confirmed) throw new DomainError("CONFIRMATION_REQUIRED", RELAY_TEXT.errConfirm)
    return ctx.rt.relays.controller.set(eq.id, ch.id, input.on, ctx.actor)
  })

/** Pulse for `ms` (native or emulated per driver). A `requireConfirm` channel needs `confirmed: true`. */
export const pulseRelay = defineAction(PulseRelayInputSchema, { auth: "user", auditDenied: "relay.pulse" },
  async function pulseRelay(input, ctx): Promise<null> {
    const { eq, ch } = await visibleChannel(ctx, input.equipmentId, input.channelId)
    if (ch.requireConfirm && !input.confirmed) throw new DomainError("CONFIRMATION_REQUIRED", RELAY_TEXT.errConfirm)
    await ctx.rt.relays.controller.pulse(eq.id, ch.id, input.ms, ctx.actor)
    return null
  })

/** Re-reads the boards behind this equipment's relays (coalesced to 1 poll per board per 2 s, §4.9). Any viewer. */
export const refreshEquipmentRelays = defineAction(EquipmentRefInputSchema, { auth: "user" },
  async function refreshEquipmentRelays(input, ctx): Promise<RelayChannelStateDTO[]> {
    const eq = await equipmentForUser(ctx.rt.prisma, ctx.user, input.equipmentId)
    if (!eq) throw new DomainError("NOT_FOUND", errorMessage("NOT_FOUND"))
    const rows = await ctx.rt.prisma.relayChannel.findMany({ where: { equipmentId: eq.id }, select: { boardId: true } })
    const boardIds = [...new Set(rows.map((r) => r.boardId))]
    await Promise.all(boardIds.map((id) => ctx.rt.relays.controller.refresh(id).catch(() => null)))
    return ctx.rt.relays.controller.channelStates(eq.id)
  })
