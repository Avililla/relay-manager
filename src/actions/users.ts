"use server"
// User actions (§7.2, W1-C). Admin only; the logic (last-admin rules, sessionVersion) lives in src/server/services/users.ts.
import { revalidatePath } from "next/cache"
import {
  CreateUserInputSchema, ResetUserPasswordInputSchema, SetUserDisabledInputSchema, UpdateUserInputSchema, UserRefInputSchema,
} from "@/lib/contracts/users"
import { defineAction } from "@/server/actions/define-action"
import * as svc from "@/server/services/users"

function refresh(): void {
  try {
    revalidatePath("/usuarios", "layout")
    revalidatePath("/roles", "layout")
  } catch {
    // outside a request scope (tests): nothing to revalidate
  }
}

export const createUser = defineAction(CreateUserInputSchema, { auth: "admin" },
  async function createUser(input, ctx): Promise<{ id: string }> {
    const r = await svc.createUser(input, ctx)
    refresh()
    return r
  })

export const updateUser = defineAction(UpdateUserInputSchema, { auth: "admin" },
  async function updateUser(input, ctx): Promise<{ id: string }> {
    const r = await svc.updateUser(input, ctx)
    refresh()
    return r
  })

export const resetUserPassword = defineAction(ResetUserPasswordInputSchema, { auth: "admin" },
  async function resetUserPassword(input, ctx): Promise<null> {
    await svc.resetUserPassword(input, ctx)
    refresh()
    return null
  })

export const setUserDisabled = defineAction(SetUserDisabledInputSchema, { auth: "admin" },
  async function setUserDisabled(input, ctx): Promise<null> {
    await svc.setUserDisabled(input, ctx)
    refresh()
    return null
  })

export const deleteUser = defineAction(UserRefInputSchema, { auth: "admin" },
  async function deleteUser(input, ctx): Promise<null> {
    await svc.deleteUser(input, ctx)
    refresh()
    return null
  })
