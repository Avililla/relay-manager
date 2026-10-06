// Template domain service (§4.15, W1-C). Templates are copied on create (D9): editing one never changes equipment,
// except through the explicit, previewed propagation (P2).
import type { z } from "zod"
import type { PrismaClient } from "@/generated/prisma/client"
import type { JsonValue } from "@/lib/contracts/common"
import { lineSummary } from "@/lib/contracts/enums"
import type {
  DuplicateTemplateInputSchema, PropagationPreviewDTO, TemplateInputSchema, TemplatePropagationInputSchema,
  TemplateRefInputSchema, TemplateSpec, TemplateSyncReportDTO, UpdateTemplateInputSchema,
} from "@/lib/contracts/templates"
import { domainText } from "@/lib/i18n/domain"
import { reloadProfileTemplates, syncChanged } from "@/server/profile"
import type { AppConfig } from "@/server/config/schema"
import { DomainError } from "@/server/errors"
import { afterCommit, conflictError, notFound } from "./common"
import type { DomainContext } from "./context"
import { lineFromRow, parseTemplateSpec, sameName } from "./dto"

type TemplateInput = z.infer<typeof TemplateInputSchema>
type UpdateTemplateInput = z.infer<typeof UpdateTemplateInputSchema>

async function assertNameFree(prisma: PrismaClient, name: string, exceptId: string | null): Promise<void> {
  const rows = await prisma.equipmentTemplate.findMany({ select: { id: true, name: true } })
  if (rows.some((r) => r.id !== exceptId && sameName(r.name, name))) throw conflictError({ name: [domainText.templateNameTaken] })
}

async function nextPosition(prisma: PrismaClient): Promise<number> {
  const agg = await prisma.equipmentTemplate.aggregate({ _max: { position: true } })
  return (agg._max.position ?? -1) + 1
}

async function load(prisma: PrismaClient, id: string) {
  const t = await prisma.equipmentTemplate.findUnique({ where: { id } })
  if (!t) throw notFound(domainText.templateMissing)
  return t
}

/** Templates defined in a profile file are read-only in the app («Duplicar» makes an editable copy). */
function assertEditable(t: { source: string; sourceFile: string | null }): void {
  if (t.source === "file") throw new DomainError("FORBIDDEN", domainText.templateFromFile(t.sourceFile ?? "plantillas/"))
}

export async function createTemplate(input: TemplateInput, ctx: DomainContext): Promise<{ id: string }> {
  const { rt, actor } = ctx
  await assertNameFree(rt.prisma, input.name, null)
  const t = await rt.prisma.equipmentTemplate.create({
    data: { name: input.name, description: input.description, spec: input.spec, source: "local", needsReview: false, position: await nextPosition(rt.prisma) },
  })
  rt.audit.record({
    actor, action: "template.create", target: { type: "template", id: t.id, name: t.name },
    detail: { consoles: input.spec.consoles.map((c) => c.key), relays: input.spec.relays.map((r) => r.key) },
  })
  return { id: t.id }
}

export async function updateTemplate(input: UpdateTemplateInput, ctx: DomainContext): Promise<{ id: string }> {
  const { rt, actor } = ctx
  const before = await load(rt.prisma, input.templateId)
  assertEditable(before)
  await assertNameFree(rt.prisma, input.name, before.id)
  const needsReview = input.markReviewed ? false : before.needsReview
  await rt.prisma.equipmentTemplate.update({
    where: { id: before.id },
    data: { name: input.name, description: input.description, spec: input.spec, needsReview },
  })
  const changed: Record<string, JsonValue> = {}
  if (before.name !== input.name) changed.name = [before.name, input.name]
  if (before.description !== input.description) changed.description = [before.description, input.description]
  if (JSON.stringify(parseTemplateSpec(before.spec)) !== JSON.stringify(input.spec)) changed.spec = true
  if (before.needsReview !== needsReview) changed.needsReview = [before.needsReview, needsReview]
  rt.audit.record({ actor, action: "template.update", target: { type: "template", id: before.id, name: input.name }, detail: { source: "editor", changed } })
  return { id: before.id }
}

export async function duplicateTemplate(input: z.infer<typeof DuplicateTemplateInputSchema>, ctx: DomainContext): Promise<{ id: string }> {
  const { rt, actor } = ctx
  const src = await load(rt.prisma, input.templateId)
  await assertNameFree(rt.prisma, input.name, null)
  const t = await rt.prisma.equipmentTemplate.create({
    data: {
      name: input.name, description: src.description, spec: parseTemplateSpec(src.spec), source: "local", key: null,
      needsReview: src.needsReview, position: await nextPosition(rt.prisma),
    },
  })
  rt.audit.record({ actor, action: "template.create", target: { type: "template", id: t.id, name: t.name }, detail: { duplicatedFrom: src.name } })
  return { id: t.id }
}

export async function deleteTemplate(input: z.infer<typeof TemplateRefInputSchema>, ctx: DomainContext): Promise<null> {
  const { rt, actor } = ctx
  const t = await load(rt.prisma, input.templateId)
  // A file template can be deleted only once its file is gone («Retirada»); otherwise the next reload would bring it back.
  if (t.source === "file" && t.retiredAt === null) throw new DomainError("FORBIDDEN", domainText.templateFromFileNotDeletable(t.sourceFile ?? "plantillas/"))
  const equipmentCount = await rt.prisma.equipment.count({ where: { templateId: t.id } })
  await rt.prisma.equipmentTemplate.delete({ where: { id: t.id } })
  rt.audit.record({ actor, action: "template.delete", target: { type: "template", id: t.id, name: t.name }, detail: { equipmentCount } })
  return null
}

/** «Recargar plantillas»: copies the profile's files (<perfil>/plantillas/*.json) into the database. */
export async function reloadTemplates(ctx: DomainContext, config: Pick<AppConfig, "profile">): Promise<TemplateSyncReportDTO> {
  const { rt, actor } = ctx
  const report = await reloadProfileTemplates(rt.prisma, config)
  if (syncChanged(report) || report.errors.length) {
    rt.audit.record({
      actor, action: "template.reload", target: { type: "template", id: null, name: "plantillas" },
      detail: { created: report.created, updated: report.updated, linked: report.linked, retired: report.retired, errors: report.errors.slice(0, 20) },
    })
  }
  return report
}

/** The wizard's starting slot draft for a template (pure; deep copies, so editing the draft never touches the spec). */
export interface TemplateDraft {
  namePattern: string
  skipInterfaces: number[]
  consoles: TemplateSpec["consoles"]
  relays: TemplateSpec["relays"]
}
export function instantiateTemplate(spec: TemplateSpec): TemplateDraft {
  return structuredClone({ namePattern: spec.namePattern, skipInterfaces: spec.skipInterfaces, consoles: spec.consoles, relays: spec.relays })
}

// ---------------------------------------------------------------------------------------------------------------------
// Propagation (P2): console label and line settings for keys on both sides, plus new unbound consoles for missing keys.
// Never deletes consoles or bindings and never touches relays.

interface PlannedChange {
  equipmentId: string; equipmentName: string; changes: string[]
  updates: Array<{ id: string; data: { label: string; baudRate: number; dataBits: number; parity: string; stopBits: number; flowControl: string } }>
  creates: Array<{ key: string; label: string; position: number; line: TemplateSpec["consoles"][number]["line"]; enterMode: string; localEcho: boolean
    identify: TemplateSpec["consoles"][number]["identify"] }>
}

async function planPropagation(prisma: PrismaClient, templateId: string, equipmentIds: readonly string[]): Promise<PlannedChange[]> {
  const t = await load(prisma, templateId)
  const spec = parseTemplateSpec(t.spec)
  const equipment = await prisma.equipment.findMany({
    where: { id: { in: [...new Set(equipmentIds)] } },
    include: { consoles: { orderBy: { position: "asc" } } },
  })
  if (equipment.length !== new Set(equipmentIds).size) throw notFound(domainText.equipmentNotFound)
  return equipment.map((eq) => {
    const plan: PlannedChange = { equipmentId: eq.id, equipmentName: eq.name, changes: [], updates: [], creates: [] }
    const byKey = new Map(eq.consoles.map((c) => [c.key, c]))
    let position = eq.consoles.reduce((m, c) => Math.max(m, c.position), -1) + 1
    for (const slot of spec.consoles) {
      const c = byKey.get(slot.key)
      if (!c) {
        plan.creates.push({ key: slot.key, label: slot.label, position: position++, line: slot.line, enterMode: slot.enterMode, localEcho: slot.localEcho, identify: slot.identify })
        plan.changes.push(`Nueva consola ${slot.key} (sin asignar)`)
        continue
      }
      const line = lineFromRow(c)
      const lineChanged = JSON.stringify(line) !== JSON.stringify(slot.line)
      if (c.label !== slot.label) plan.changes.push(`${slot.key}: etiqueta de «${c.label}» a «${slot.label}»`)
      if (lineChanged) plan.changes.push(`${slot.key}: de ${lineSummary(line)} a ${lineSummary(slot.line)}`)
      if (c.label !== slot.label || lineChanged) {
        plan.updates.push({ id: c.id, data: { label: slot.label, baudRate: slot.line.baudRate, dataBits: slot.line.dataBits, parity: slot.line.parity, stopBits: slot.line.stopBits, flowControl: slot.line.flowControl } })
      }
    }
    return plan
  })
}

export async function previewPropagation(input: z.infer<typeof TemplatePropagationInputSchema>, ctx: DomainContext): Promise<PropagationPreviewDTO> {
  const plans = await planPropagation(ctx.rt.prisma, input.templateId, input.equipmentIds)
  return { items: plans.map((p) => ({ equipmentId: p.equipmentId, equipmentName: p.equipmentName, changes: p.changes })) }
}

export async function applyPropagation(input: z.infer<typeof TemplatePropagationInputSchema>, ctx: DomainContext): Promise<{ updated: number }> {
  const { rt, actor } = ctx
  const plans = (await planPropagation(rt.prisma, input.templateId, input.equipmentIds)).filter((p) => p.changes.length)
  if (!plans.length) return { updated: 0 }
  await rt.prisma.$transaction(async (tx) => {
    for (const p of plans) {
      for (const u of p.updates) await tx.serialConsole.update({ where: { id: u.id }, data: u.data })
      for (const c of p.creates) {
        await tx.serialConsole.create({
          data: {
            equipmentId: p.equipmentId, key: c.key, label: c.label, position: c.position,
            baudRate: c.line.baudRate, dataBits: c.line.dataBits, parity: c.line.parity, stopBits: c.line.stopBits, flowControl: c.line.flowControl,
            enterMode: c.enterMode, localEcho: c.localEcho,
            identifyHostnameRegex: c.identify.hostnameRegex ?? null, identifyBannerRegex: c.identify.bannerRegex ?? null,
          },
        })
      }
    }
  })
  for (const p of plans) {
    await afterCommit(rt.log, "recargar consolas", () => rt.serial.consoles.reloadEquipment(p.equipmentId))
    rt.bus.publish({ type: "equipment.changed", equipmentId: p.equipmentId, change: "updated" }, { kind: "all" })
  }
  const t = await rt.prisma.equipmentTemplate.findUnique({ where: { id: input.templateId }, select: { name: true } })
  rt.audit.record({
    actor, action: "template.propagate", target: { type: "template", id: input.templateId, name: t?.name ?? null },
    detail: { equipment: plans.map((p) => ({ name: p.equipmentName, changes: p.changes })) },
  })
  return { updated: plans.length }
}
