"use server"
// "Archivos": new folder, rename, move and delete (any signed-in user; delete can be limited to administrators with
// RM_FILES_DELETE=admins). Uploads and downloads stream through the Graph A API (/api/files/*), not through actions.
import { revalidatePath } from "next/cache"
import {
  CreateFolderInputSchema, DeleteEntriesInputSchema, MoveEntriesInputSchema, RenameEntryInputSchema,
} from "@/lib/contracts/files"
import { validateNewName } from "@/lib/files/names"
import { defineAction } from "@/server/actions/define-action"
import { DomainError } from "@/server/errors"

function refresh(): void {
  try {
    revalidatePath("/archivos")
  } catch {
    // outside a request scope (tests)
  }
}

function checkName(field: string, name: string): void {
  const why = validateNewName(name)
  if (why) throw new DomainError("VALIDATION", why, { [field]: [why] })
}

export const createFolder = defineAction(CreateFolderInputSchema, { auth: "user" },
  async function createFolder(input, ctx): Promise<{ path: string }> {
    checkName("name", input.name)
    const r = await ctx.rt.files.mkdir(input.root, input.dir, input.name, ctx.actor)
    refresh()
    return r
  })

export const renameEntry = defineAction(RenameEntryInputSchema, { auth: "user" },
  async function renameEntry(input, ctx): Promise<{ path: string }> {
    checkName("newName", input.newName)
    const r = await ctx.rt.files.rename(input.root, input.path, input.newName, ctx.actor)
    refresh()
    return r
  })

export const moveEntries = defineAction(MoveEntriesInputSchema, { auth: "user" },
  async function moveEntries(input, ctx): Promise<{ moved: number }> {
    const r = await ctx.rt.files.move(input.root, input.paths, input.toDir, ctx.actor)
    refresh()
    return r
  })

export const deleteEntries = defineAction(DeleteEntriesInputSchema, { auth: "user" },
  async function deleteEntries(input, ctx): Promise<{ removed: number }> {
    if (ctx.rt.config.files.deleteAdminOnly && !ctx.user.isAdmin) {
      throw new DomainError("FORBIDDEN", "Solo los administradores pueden borrar archivos en este servidor.")
    }
    const r = await ctx.rt.files.remove(input.root, input.paths, ctx.actor)
    refresh()
    return r
  })
