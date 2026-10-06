"use server"
// Cable inventory ("Cables") and JTAG rescan. Admin only; the logic lives in src/server/services/accesses.ts.
import { revalidatePath } from "next/cache"
import { z } from "zod"
import { CableLabelRefInputSchema, CreateCableLabelInputSchema, UpdateCableLabelInputSchema, type JtagSnapshotDTO } from "@/lib/contracts/accesses"
import { defineAction } from "@/server/actions/define-action"
import * as svc from "@/server/services/accesses"

function refresh(): void {
  try {
    revalidatePath("/cables")
    revalidatePath("/descubrimiento")
    revalidatePath("/sistema/accesos")
  } catch {
    // outside a request scope (tests)
  }
}

export const createCableLabel = defineAction(CreateCableLabelInputSchema, { auth: "admin" },
  async function createCableLabel(input, ctx): Promise<{ id: string }> {
    const r = await svc.createCableLabel(input, ctx)
    refresh()
    return r
  })

export const updateCableLabel = defineAction(UpdateCableLabelInputSchema, { auth: "admin" },
  async function updateCableLabel(input, ctx): Promise<{ id: string }> {
    const r = await svc.updateCableLabel(input, ctx)
    refresh()
    return r
  })

export const deleteCableLabel = defineAction(CableLabelRefInputSchema, { auth: "admin" },
  async function deleteCableLabel(input, ctx): Promise<null> {
    await svc.deleteCableLabel(input, ctx)
    refresh()
    return null
  })

export const rescanJtagCables = defineAction(z.strictObject({}), { auth: "admin" },
  async function rescanJtagCables(_input, ctx): Promise<JtagSnapshotDTO> {
    const r = await ctx.rt.accesses.rescanJtag(ctx.actor)
    refresh()
    return r
  })
