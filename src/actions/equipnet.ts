"use server"
// "Red de equipos" (admin only): the interface of the switch (explicit choice), settings, switch search on that
// interface, preview/apply of the switch setup (explicit confirmation, audited), "Preparar switch", the removal of
// leftovers of older versions and a manual reconcile of the server side. The logic lives in rt.equipnet.
import { revalidatePath } from "next/cache"
import { z } from "zod"
import {
  ChooseAdapterInputSchema, DiscoverSwitchInputSchema, EquipnetSettingsInputSchema, PrepareSwitchInputSchema, SwitchApplyInputSchema, SwitchPreviewInputSchema,
  type EquipnetSettingsDTO, type EquipnetStatusDTO, type SwitchDetectionDTO, type SwitchJobDTO, type SwitchPreviewDTO, type SwitchStatusDTO,
} from "@/lib/contracts/equipnet"
import { defineAction } from "@/server/actions/define-action"

function refresh(): void {
  try {
    revalidatePath("/sistema/red-equipos")
    revalidatePath("/")
    revalidatePath("/cables")
  } catch {
    // outside a request scope (tests)
  }
}

/** Saves the settings; `warnings` are situations that work but the admin should know (shown with the confirmation). */
export const saveEquipnetSettings = defineAction(EquipnetSettingsInputSchema, { auth: "admin" },
  async function saveEquipnetSettings(input, ctx): Promise<{ settings: EquipnetSettingsDTO; warnings: string[] }> {
    const r = await ctx.rt.equipnet.saveSettings(input, ctx.actor)
    refresh()
    return r
  })

/** Step 1, «Usar esta» / «Dejar de usar»: the only way the app starts (or stops) touching a network interface. */
export const chooseEquipnetAdapter = defineAction(ChooseAdapterInputSchema, { auth: "admin" },
  async function chooseEquipnetAdapter(input, ctx): Promise<EquipnetStatusDTO> {
    const r = await ctx.rt.equipnet.chooseAdapter({ mac: input.mac, confirmed: input.confirmed }, ctx.actor)
    refresh()
    return r
  })

/** «Quitar restos»: removes what older versions left on interfaces the app may not touch on its own. */
export const cleanupEquipnetLeftovers = defineAction(z.strictObject({}), { auth: "admin" },
  async function cleanupEquipnetLeftovers(_input, ctx): Promise<EquipnetStatusDTO> {
    const r = await ctx.rt.equipnet.cleanupLeftovers(ctx.actor)
    refresh()
    return r
  })

/** Step 2, «Buscar el switch»: only on the chosen interface (a sweep of its management network, or the typed IP). */
export const discoverSwitch = defineAction(DiscoverSwitchInputSchema, { auth: "admin" },
  async function discoverSwitch(input, ctx): Promise<SwitchDetectionDTO | null> {
    const r = await ctx.rt.equipnet.discover(input.host ?? null, ctx.actor)
    refresh()
    return r
  })

export const testSwitch = defineAction(z.strictObject({}), { auth: "admin" },
  async function testSwitch(_input, ctx): Promise<SwitchStatusDTO> {
    return ctx.rt.equipnet.testSwitch(ctx.actor)
  })

/** "Se va a cambiar…": reads the switch (never changes it) and returns the plan to confirm. */
export const previewSwitch = defineAction(SwitchPreviewInputSchema, { auth: "admin" },
  async function previewSwitch(input, ctx): Promise<SwitchPreviewDTO> {
    return ctx.rt.equipnet.preview(input.kind, ctx.actor)
  })

/** Applies a previewed plan (its id and `confirmed: true`): runs in the background, progress on the SSE stream. */
export const applySwitch = defineAction(SwitchApplyInputSchema, { auth: "admin" },
  async function applySwitch(input, ctx): Promise<SwitchJobDTO> {
    const r = await ctx.rt.equipnet.apply({ kind: input.kind, planId: input.planId, uplinkConfirmed: input.uplinkConfirmed }, ctx.actor)
    refresh()
    return r
  })

/** «Preparar switch» › "Detalles": what it would change, with the typed password (nothing is saved). */
export const previewPrepareSwitch = defineAction(PrepareSwitchInputSchema, { auth: "admin" },
  async function previewPrepareSwitch(input, ctx): Promise<SwitchPreviewDTO> {
    return ctx.rt.equipnet.previewPrepare({ password: input.password, username: input.username }, ctx.actor)
  })

/** Step 3, «Preparar switch»: the click is the confirmation; blocked plans come back as a preview instead. */
export const prepareSwitch = defineAction(PrepareSwitchInputSchema.extend({ uplinkConfirmed: z.boolean().default(false) }), { auth: "admin" },
  async function prepareSwitch(input, ctx): Promise<{ started: boolean; preview: SwitchPreviewDTO | null; job: SwitchJobDTO | null; warnings: string[] }> {
    const r = await ctx.rt.equipnet.prepare({ password: input.password, username: input.username, uplinkConfirmed: input.uplinkConfirmed }, ctx.actor)
    refresh()
    return r
  })

export const reconcileEquipnet = defineAction(z.strictObject({}), { auth: "admin" },
  async function reconcileEquipnet(_input, ctx): Promise<EquipnetStatusDTO> {
    const r = await ctx.rt.equipnet.reconcileNow(ctx.actor)
    refresh()
    return r
  })
