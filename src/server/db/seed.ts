import type { PrismaClient } from "@/generated/prisma/client"
import { DEFAULT_LAB_NAME } from "@/lib/i18n/common"

export interface SeedOptions {
  /** Settings.labName of a NEW settings row (RM_LAB_NAME; an existing row keeps its own). */
  labName?: string
}

/**
 * Idempotent defaults, run at every start (§3.2): the settings row. No users, roles, templates, equipment or boards
 * (templates come from the profile's files: src/server/profile/sync.ts).
 */
export async function seedDefaults(prisma: PrismaClient, opts: SeedOptions = {}): Promise<{ settingsCreated: boolean }> {
  const existing = await prisma.settings.findUnique({ where: { id: "global" }, select: { id: true } })
  await prisma.settings.upsert({ where: { id: "global" }, create: { labName: opts.labName ?? DEFAULT_LAB_NAME }, update: {} })
  return { settingsCreated: !existing }
}
