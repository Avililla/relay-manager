"use server"
// Settings action (§7.2, W1-C). The W0 settings service validates, writes, publishes settings.changed and audits.
import { revalidatePath } from "next/cache"
import { UpdateSettingsInputSchema, type SettingsDTO } from "@/lib/contracts/settings"
import { defineAction } from "@/server/actions/define-action"

export const updateSettings = defineAction(
  UpdateSettingsInputSchema,
  { auth: "admin" },
  async function updateSettings(input, ctx): Promise<SettingsDTO> {
    const s = await ctx.rt.settings.update(input, ctx.actor)
    try {
      revalidatePath("/", "layout")
    } catch {
      // outside a request scope (tests): nothing to revalidate
    }
    return s
  },
)
