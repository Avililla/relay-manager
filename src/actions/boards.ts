"use server"
// Relay board actions (§7.2, W1-B). Admin only. After every change the controller reloads (timers, channels) and the
// board pages are revalidated. Passwords never reach the client or the audit log (credentialSet / credentialChanged only:
// W0's audit redaction would blank any key that contains "pass").
import { revalidatePath } from "next/cache"
import type { JsonValue } from "@/lib/contracts/common"
import {
  BoardConnectionInputSchema, BoardInputSchema, BoardRefInputSchema, DeleteBoardInputSchema, SetBoardEnabledInputSchema,
  UpdateBoardHostInputSchema, UpdateBoardInputSchema, type BoardInput, type BoardRuntimeDTO, type DetectResultDTO,
} from "@/lib/contracts/relays"
import { errorMessage } from "@/lib/i18n/errors"
import { RELAY_TEXT } from "@/lib/i18n/relays"
import { driverCapabilities } from "@/lib/relays/capabilities"
import { defineAction, type ActionContext } from "@/server/actions/define-action"
import { DomainError } from "@/server/errors"

function revalidateBoards(id?: string): void {
  revalidatePath("/placas")
  if (id) revalidatePath(`/placas/${id}`)
  revalidatePath("/descubrimiento")
}

/** Driver policy, relay count and uniqueness (name, host+port, MAC) with Spanish field errors. */
async function validateBoard(ctx: ActionContext, input: Pick<BoardInput, "name" | "driver" | "host" | "httpPort" | "mac" | "relayCount" | "model" | "options">, boardId?: string): Promise<void> {
  if (input.driver === "simulated" && !ctx.rt.relays.simulatedAllowed()) {
    throw new DomainError("VALIDATION", RELAY_TEXT.errSimulatedNotAllowed, { driver: [RELAY_TEXT.errSimulatedNotAllowed] })
  }
  const max = driverCapabilities(input.driver, input).maxRelays
  if (input.relayCount > max) {
    throw new DomainError("VALIDATION", errorMessage("VALIDATION"), { relayCount: [RELAY_TEXT.errRelayCountTooHigh(max)] })
  }
  const others = await ctx.rt.prisma.relayBoard.findMany({
    where: { id: boardId ? { not: boardId } : undefined, OR: [{ name: input.name }, { host: input.host, httpPort: input.httpPort }, ...(input.mac ? [{ mac: input.mac }] : [])] },
    select: { name: true, host: true, httpPort: true, mac: true },
  })
  const fe: Record<string, string[]> = {}
  if (others.some((o) => o.name === input.name)) fe.name = [RELAY_TEXT.errNameTaken]
  if (others.some((o) => o.host === input.host && o.httpPort === input.httpPort)) fe.host = [RELAY_TEXT.errAddressTaken]
  if (input.mac && others.some((o) => o.mac === input.mac)) fe.mac = [RELAY_TEXT.errMacTaken]
  if (Object.keys(fe).length) throw new DomainError("CONFLICT", Object.values(fe)[0]?.[0] ?? errorMessage("CONFLICT"), fe)
}

function auditSummary(b: { name: string; driver: string; host: string; httpPort: number; tcpPort: number | null; model: string | null; relayCount: number; mac: string | null }): Record<string, JsonValue> {
  return { name: b.name, driver: b.driver, host: b.host, httpPort: b.httpPort, tcpPort: b.tcpPort, model: b.model, relayCount: b.relayCount, mac: b.mac }
}

export const createBoard = defineAction(BoardInputSchema, { auth: "admin" }, async function createBoard(input, ctx): Promise<{ id: string }> {
  await validateBoard(ctx, input)
  const b = await ctx.rt.prisma.relayBoard.create({
    data: {
      name: input.name, driver: input.driver, host: input.host, httpPort: input.httpPort, tcpPort: input.tcpPort,
      model: input.model, moduleId: input.moduleId, mac: input.mac, relayCount: input.relayCount, options: input.options,
      username: input.username, password: input.password ?? null, enabled: input.enabled,
    },
  })
  await ctx.rt.relays.controller.reload()
  ctx.rt.audit.record({
    actor: ctx.actor, action: "board.create", target: { type: "board", id: b.id, name: b.name },
    detail: { ...auditSummary(b), enabled: b.enabled, credentialSet: b.password !== null },
  })
  revalidateBoards(b.id)
  return { id: b.id }
})

export const updateBoard = defineAction(UpdateBoardInputSchema, { auth: "admin" }, async function updateBoard(input, ctx): Promise<{ id: string }> {
  const before = await ctx.rt.prisma.relayBoard.findUnique({ where: { id: input.boardId }, include: { channels: { select: { channel: true } } } })
  if (!before) throw new DomainError("NOT_FOUND", RELAY_TEXT.errBoardNotFound)
  await validateBoard(ctx, input, before.id)
  const highest = Math.max(0, ...before.channels.map((c) => c.channel))
  if (input.relayCount < highest) {
    throw new DomainError("VALIDATION", errorMessage("VALIDATION"), { relayCount: [RELAY_TEXT.errRelayCountBelowBound(highest)] })
  }
  const connectionChanged = before.driver !== input.driver || before.host !== input.host || before.httpPort !== input.httpPort ||
    before.tcpPort !== input.tcpPort || before.relayCount !== input.relayCount
  const after = await ctx.rt.prisma.relayBoard.update({
    where: { id: before.id },
    data: {
      name: input.name, driver: input.driver, host: input.host, httpPort: input.httpPort, tcpPort: input.tcpPort,
      model: input.model, moduleId: input.moduleId, mac: input.mac, relayCount: input.relayCount, options: input.options,
      username: input.username, enabled: input.enabled,
      ...(input.password !== undefined ? { password: input.password } : {}),
      ...(connectionChanged ? { relayState: "", online: false } : {}),
    },
  })
  await ctx.rt.relays.controller.reload()
  const changed: Record<string, JsonValue> = {}
  const fields = ["name", "driver", "host", "httpPort", "tcpPort", "model", "moduleId", "mac", "relayCount", "username", "enabled"] as const
  for (const f of fields) if (before[f] !== after[f]) changed[f] = [before[f], after[f]]
  if (JSON.stringify(before.options ?? {}) !== JSON.stringify(after.options ?? {})) changed.options = [before.options as JsonValue ?? null, after.options as JsonValue ?? null]
  ctx.rt.audit.record({
    actor: ctx.actor, action: "board.update", target: { type: "board", id: after.id, name: after.name },
    detail: { changed, credentialChanged: input.password !== undefined && input.password !== before.password },
  })
  if (before.enabled !== after.enabled) {
    ctx.rt.audit.record({ actor: ctx.actor, action: after.enabled ? "board.enable" : "board.disable", target: { type: "board", id: after.id, name: after.name } })
  }
  revalidateBoards(after.id)
  return { id: after.id }
})

/** Detach semantics (D7): the board and its channels go; equipment stays. */
export const deleteBoard = defineAction(DeleteBoardInputSchema, { auth: "admin" }, async function deleteBoard(input, ctx): Promise<{ detachedChannels: number }> {
  const b = await ctx.rt.prisma.relayBoard.findUnique({
    where: { id: input.boardId },
    include: { channels: { select: { channel: true, label: true, equipment: { select: { id: true, name: true } } } } },
  })
  if (!b) throw new DomainError("NOT_FOUND", RELAY_TEXT.errBoardNotFound)
  if (input.confirmName !== b.name) throw new DomainError("VALIDATION", RELAY_TEXT.errConfirmName, { confirmName: [RELAY_TEXT.errConfirmName] })
  await ctx.rt.prisma.relayBoard.delete({ where: { id: b.id } })
  await ctx.rt.relays.controller.reload()
  const equipment = new Map(b.channels.map((c) => [c.equipment.id, c.equipment.name]))
  ctx.rt.audit.record({
    actor: ctx.actor, action: "board.delete", target: { type: "board", id: b.id, name: b.name },
    detail: { ...auditSummary(b), detachedChannels: b.channels.length, equipment: [...equipment.values()],
      channels: b.channels.map((c) => ({ channel: c.channel, label: c.label, equipment: c.equipment.name })) },
  })
  for (const id of equipment.keys()) {
    ctx.rt.bus.publish({ type: "equipment.changed", equipmentId: id, change: "updated" }, { kind: "all" })
    revalidatePath(`/equipos/${id}`)
  }
  revalidatePath("/")
  revalidateBoards()
  return { detachedChannels: b.channels.length }
})

export const setBoardEnabled = defineAction(SetBoardEnabledInputSchema, { auth: "admin" }, async function setBoardEnabled(input, ctx): Promise<null> {
  const b = await ctx.rt.prisma.relayBoard.findUnique({ where: { id: input.boardId }, select: { id: true, name: true, driver: true, enabled: true } })
  if (!b) throw new DomainError("NOT_FOUND", RELAY_TEXT.errBoardNotFound)
  if (input.enabled && b.driver === "simulated" && !ctx.rt.relays.simulatedAllowed()) {
    throw new DomainError("VALIDATION", RELAY_TEXT.errSimulatedNotAllowed, { driver: [RELAY_TEXT.errSimulatedNotAllowed] })
  }
  if (b.enabled !== input.enabled) {
    await ctx.rt.prisma.relayBoard.update({ where: { id: b.id }, data: { enabled: input.enabled } })
    await ctx.rt.relays.controller.reload()
    ctx.rt.audit.record({ actor: ctx.actor, action: input.enabled ? "board.enable" : "board.disable", target: { type: "board", id: b.id, name: b.name } })
  }
  revalidateBoards(b.id)
  return null
})

/** "Probar conexión": read-only autodetect, no DB access (the controller audits board.test). */
export const testBoardConnection = defineAction(BoardConnectionInputSchema, { auth: "admin" }, async function testBoardConnection(input, ctx): Promise<DetectResultDTO[]> {
  if (input.driver === "simulated" && !ctx.rt.relays.simulatedAllowed()) {
    throw new DomainError("VALIDATION", RELAY_TEXT.errSimulatedNotAllowed, { driver: [RELAY_TEXT.errSimulatedNotAllowed] })
  }
  return ctx.rt.relays.controller.test(input, ctx.actor)
})

export const refreshBoard = defineAction(BoardRefInputSchema, { auth: "admin" }, async function refreshBoard(input, ctx): Promise<BoardRuntimeDTO> {
  if (!ctx.rt.relays.controller.boardRuntime(input.boardId)) await ctx.rt.relays.controller.reload()
  return ctx.rt.relays.controller.refresh(input.boardId)
})

/** "Actualizar IP" from a discovered "IP cambiada" (D22): the admin decides; an announcement never does. */
export const updateBoardHost = defineAction(UpdateBoardHostInputSchema, { auth: "admin" }, async function updateBoardHost(input, ctx): Promise<null> {
  const b = await ctx.rt.prisma.relayBoard.findUnique({ where: { id: input.boardId }, select: { id: true, name: true, host: true, httpPort: true } })
  if (!b) throw new DomainError("NOT_FOUND", RELAY_TEXT.errBoardNotFound)
  if (b.host === input.host) return null
  const clash = await ctx.rt.prisma.relayBoard.findFirst({ where: { id: { not: b.id }, host: input.host, httpPort: b.httpPort }, select: { id: true } })
  if (clash) throw new DomainError("CONFLICT", RELAY_TEXT.errAddressTaken, { host: [RELAY_TEXT.errAddressTaken] })
  await ctx.rt.prisma.relayBoard.update({ where: { id: b.id }, data: { host: input.host, relayState: "", online: false } })
  await ctx.rt.relays.controller.reload()
  ctx.rt.audit.record({ actor: ctx.actor, action: "board.host.update", target: { type: "board", id: b.id, name: b.name }, detail: { before: b.host, after: input.host } })
  revalidateBoards(b.id)
  return null
})
