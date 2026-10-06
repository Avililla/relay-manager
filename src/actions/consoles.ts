"use server"
// Serial console actions (W1-A, §7.2). Stateful work goes through getRuntime() (defineAction's ctx.rt).
import { EmptyInputSchema } from "@/lib/contracts/common"
import {
  ConsoleRefInputSchema, IdentifyPortsInputSchema, PokePortInputSchema, ReleaseConsoleInputSchema,
} from "@/lib/contracts/serial"
import { errorMessage } from "@/lib/i18n/errors"
import { SERIAL_ERROR } from "@/lib/i18n/serial"
import { consoleForUser } from "@/server/access"
import { defineAction, type ActionContext } from "@/server/actions/define-action"
import { canWriteConsoleEquipment } from "@/server/authz-rules"
import { DomainError } from "@/server/errors"

/** Visible console + the write rule (§4.5 rule 8, D24); the console manager checks the rule again. */
async function writableConsole(ctx: ActionContext, consoleId: string) {
  const c = await consoleForUser(ctx.rt.prisma, ctx.user, consoleId)
  if (!c) throw new DomainError("NOT_FOUND", errorMessage("NOT_FOUND"))
  const reservation = ctx.rt.reservations.get(c.id)
  const rule = canWriteConsoleEquipment(reservation, { id: ctx.user.id, isAdmin: ctx.user.isAdmin })
  if (rule === "NOT_HOLDER") throw new DomainError("NOT_HOLDER", errorMessage("NOT_HOLDER"))
  if (rule === "RESERVED_BY_OTHER") {
    const details = { holderName: reservation?.holderName ?? "" }
    throw new DomainError("RESERVED_BY_OTHER", errorMessage("RESERVED_BY_OTHER", details), undefined, details)
  }
  return { ...c, actor: { ...ctx.actor, isAdmin: ctx.user.isAdmin, displayName: ctx.user.name } }
}

export const rescanSerial = defineAction(EmptyInputSchema, { auth: "admin" }, async function rescanSerial(_input, ctx) {
  return ctx.rt.serial.discovery.rescan(ctx.actor)
})

/** Passive only: opens, listens, classifies, closes; never writes (D3). */
export const identifyPorts = defineAction(IdentifyPortsInputSchema, { auth: "admin" }, async function identifyPorts(input, ctx) {
  return ctx.rt.serial.probe.identify(input.stableKeys, { baudRate: input.baudRate, listenMs: input.listenMs }, ctx.actor)
})

/** Exactly one "\r" to a free, unbound port; `confirmed: true` is required by the schema (D3). */
export const pokePort = defineAction(PokePortInputSchema, { auth: "admin" }, async function pokePort(input, ctx) {
  if (!ctx.rt.config.serial.allowPoke) throw new DomainError("DISABLED_BY_POLICY", SERIAL_ERROR.pokeDisabled)
  return ctx.rt.serial.probe.poke(input.stableKey, { baudRate: input.baudRate }, ctx.actor)
})

export const releaseConsolePort = defineAction(ReleaseConsoleInputSchema, { auth: "user", auditDenied: "console.release" }, async function releaseConsolePort(input, ctx) {
  const c = await writableConsole(ctx, input.consoleId)
  return ctx.rt.serial.consoles.release(c.consoleId, c.actor, input.durationMin)
})

export const retakeConsolePort = defineAction(ConsoleRefInputSchema, { auth: "user", auditDenied: "console.retake" }, async function retakeConsolePort(input, ctx) {
  const c = await writableConsole(ctx, input.consoleId)
  return ctx.rt.serial.consoles.retake(c.consoleId, c.actor)
})

export const clearConsoleHistory = defineAction(ConsoleRefInputSchema, { auth: "user", auditDenied: "console.clear" }, async function clearConsoleHistory(input, ctx) {
  const c = await writableConsole(ctx, input.consoleId)
  await ctx.rt.serial.consoles.clearHistory(c.consoleId, c.actor)
  return null
})
