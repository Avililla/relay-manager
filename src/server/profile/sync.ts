// Copies the profile's template files into the database (EquipmentTemplate rows with source "file"). Runs on every
// start, on «Recargar plantillas» (administrators) and with `relay-manager plantillas recargar`. Never deletes a row and
// never touches equipment (templates are copied when an equipment is created, D9):
//  - a file without a row → a new "file" template;
//  - a "file" row → updated from its file («Retirada» cleared if the file is back);
//  - a "local" row with the same key (a 2.x predefined template, or an imported one with a key) → linked to the file;
//  - an invalid file → its row (if its key can be read) stays as it is;
//  - a "file" row whose file is gone → «Retirada» (only when the plantillas/ folder could be read at all).
import type { PrismaClient } from "@/generated/prisma/client"
import type { TemplateSyncReportDTO } from "@/lib/contracts/templates"
import { parseTemplateSpec, sameName } from "@/server/services/dto"
import { templateErrorLines, type ProfileTemplates } from "./templates"

export async function syncProfileTemplates(prisma: PrismaClient, loaded: ProfileTemplates, opts: { now?: Date } = {}): Promise<TemplateSyncReportDTO> {
  const now = opts.now ?? new Date()
  const report: TemplateSyncReportDTO = {
    dir: loaded.dir, created: [], updated: [], linked: [], retired: [], unchanged: 0, warnings: [], errors: templateErrorLines(loaded),
  }
  const rows = await prisma.equipmentTemplate.findMany({ orderBy: { createdAt: "asc" } })
  const names = new Map(rows.map((r) => [r.id, r.name]))
  const freeName = (wanted: string, key: string, selfId: string | null): string => {
    const taken = (n: string) => [...names].some(([id, other]) => id !== selfId && sameName(other, n))
    if (!taken(wanted)) return wanted
    for (let i = 1; i < 100; i++) {
      const alt = (i === 1 ? `${wanted} (${key})` : `${wanted} (${key} ${i})`).slice(0, 40)
      if (!taken(alt)) {
        report.warnings.push(`La plantilla «${wanted}» (${key}) se llama «${alt}»: ya hay otra plantilla con ese nombre`)
        return alt
      }
    }
    return `${wanted.slice(0, 25)} ${now.getTime()}`
  }
  for (const t of [...loaded.templates].sort((a, b) => a.order - b.order)) {
    const row = rows.find((r) => r.key === t.key) ?? null
    const name = freeName(t.name, t.key, row?.id ?? null)
    const data = {
      name, description: t.description, needsReview: t.needsReview, position: t.order, spec: t.spec,
      source: "file", sourceFile: t.file, retiredAt: null,
    }
    if (!row) {
      const created = await prisma.equipmentTemplate.create({ data: { key: t.key, ...data } })
      names.set(created.id, name)
      report.created.push(name)
      continue
    }
    names.set(row.id, name)
    if (row.source !== "file") {
      await prisma.equipmentTemplate.update({ where: { id: row.id }, data })
      report.linked.push(name)
      continue
    }
    const same = row.name === name && row.description === t.description && row.needsReview === t.needsReview && row.position === t.order
      && row.sourceFile === t.file && row.retiredAt === null && JSON.stringify(parseTemplateSpec(row.spec)) === JSON.stringify(t.spec)
    if (same) {
      report.unchanged++
      continue
    }
    await prisma.equipmentTemplate.update({ where: { id: row.id }, data })
    report.updated.push(name)
  }
  if (loaded.found) {
    const keep = new Set([...loaded.templates.map((t) => t.key), ...loaded.errors.map((e) => e.key).filter((k): k is string => !!k)])
    for (const r of rows) {
      if (r.source !== "file" || r.retiredAt !== null || (r.key && keep.has(r.key))) continue
      await prisma.equipmentTemplate.update({ where: { id: r.id }, data: { retiredAt: now } })
      report.retired.push(r.name)
    }
  } else if (loaded.dir && rows.some((r) => r.source === "file" && r.retiredAt === null)) {
    report.warnings.push(`No se encuentra ${loaded.dir}/plantillas: las plantillas definidas en ficheros no cambian`)
  }
  return report
}

export function syncChanged(r: TemplateSyncReportDTO): boolean {
  return r.created.length + r.updated.length + r.linked.length + r.retired.length > 0
}

/** Spanish summary lines of a report (CLI and logs). */
export function syncReportLines(r: TemplateSyncReportDTO): string[] {
  const out: string[] = []
  const list = (label: string, xs: string[]) => { if (xs.length) out.push(`${label} (${xs.length}): ${xs.map((x) => `«${x}»`).join(", ")}`) }
  list("Creadas", r.created)
  list("Actualizadas", r.updated)
  list("Vinculadas a su fichero", r.linked)
  list("Retiradas (sin fichero)", r.retired)
  if (r.unchanged) out.push(`Sin cambios: ${r.unchanged}`)
  for (const w of r.warnings) out.push(`Aviso: ${w}`)
  for (const e of r.errors) out.push(`Error: ${e}`)
  return out
}
