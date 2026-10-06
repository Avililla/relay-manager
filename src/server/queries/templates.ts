import "server-only"
// Template read side (§7.4, W1-C). Admin pages call requireAdmin() first.
import type { TemplateDTO } from "@/lib/contracts/templates"
import { readProfileTemplatesFor, templateErrorLines } from "@/server/profile"
import { getRuntime } from "@/server/runtime/registry"
import { toTemplateDTO } from "@/server/services/dto"

/** Ordered by position, then name; retired ones last. */
export async function listTemplates(): Promise<TemplateDTO[]> {
  const rows = await getRuntime().prisma.equipmentTemplate.findMany({ include: { _count: { select: { equipments: true } } } })
  rows.sort((a, b) => Number(a.retiredAt !== null) - Number(b.retiredAt !== null) || a.position - b.position || a.name.localeCompare(b.name, "es", { numeric: true }))
  return rows.map((r) => toTemplateDTO(r, r._count.equipments))
}

export async function getTemplate(id: string): Promise<TemplateDTO | null> {
  const r = await getRuntime().prisma.equipmentTemplate.findUnique({ where: { id }, include: { _count: { select: { equipments: true } } } })
  return r ? toTemplateDTO(r, r._count.equipments) : null
}

export interface TemplatesProfileInfo {
  /** The profile directory (null: none). */
  dir: string | null
  /** Where the profile is looked for (shown in the empty state). */
  path: string
  /** Current problems of the template files (read now, not at the last reload). */
  errors: string[]
}

/** What Plantillas says about the profile: where the template files live and what is wrong with them. */
export function getTemplatesProfileInfo(): TemplatesProfileInfo {
  const cfg = getRuntime().config
  const errors = cfg.profile.dir ? templateErrorLines(readProfileTemplatesFor(cfg)) : []
  return { dir: cfg.profile.dir, path: cfg.profile.path, errors }
}
