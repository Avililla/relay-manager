"use server"
// Role actions (§7.2, W1-C). Admin only; the logic lives in src/server/services/roles.ts.
import { revalidatePath } from "next/cache"
import { RoleInputSchema, RoleRefInputSchema, UpdateRoleInputSchema } from "@/lib/contracts/users"
import { defineAction } from "@/server/actions/define-action"
import * as svc from "@/server/services/roles"

function refresh(): void {
  try {
    revalidatePath("/roles", "layout")
    revalidatePath("/usuarios", "layout")
    revalidatePath("/")
  } catch {
    // outside a request scope (tests): nothing to revalidate
  }
}

export const createRole = defineAction(RoleInputSchema, { auth: "admin" },
  async function createRole(input, ctx): Promise<{ id: string }> {
    const r = await svc.createRole(input, ctx)
    refresh()
    return r
  })

export const updateRole = defineAction(UpdateRoleInputSchema, { auth: "admin" },
  async function updateRole(input, ctx): Promise<{ id: string }> {
    const r = await svc.updateRole(input, ctx)
    refresh()
    return r
  })

export const deleteRole = defineAction(RoleRefInputSchema, { auth: "admin" },
  async function deleteRole(input, ctx): Promise<null> {
    await svc.deleteRole(input, ctx)
    refresh()
    return null
  })
