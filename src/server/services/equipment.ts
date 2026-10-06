// Equipment domain service (§4.15, W1-C): create (with template write-back), full edit, bindings, delete, reorder.
// Stateless: every function takes its deps through the DomainContext.
import type { z } from "zod"
import type { Prisma, PrismaClient, SerialConsole } from "@/generated/prisma/client"
import type { JsonValue } from "@/lib/contracts/common"
import type {
  ConsoleConfigInput, CreateEquipmentInput, DeleteEquipmentInputSchema, RelayChannelInput, ReorderEquipmentInputSchema,
  UpdateEquipmentBindingsInputSchema, UpdateEquipmentInput,
} from "@/lib/contracts/equipment"
import type { ConsoleBindingRecord } from "@/lib/contracts/serial"
import { TemplateSpecSchema, type TemplateSpec } from "@/lib/contracts/templates"
import { domainFormat, domainText } from "@/lib/i18n/domain"
import { errorMessage } from "@/lib/i18n/errors"
import { toFieldErrors } from "@/server/actions/field-errors"
import { equipmentForUser } from "@/server/access"
import { DomainError } from "@/server/errors"
import type { DomainDeps } from "@/server/runtime/types"
import {
  afterCommit, assertRolesExist, conflictError, notFound, prefixFieldErrors, scalarDiff, validationError,
} from "./common"
import type { DomainContext } from "./context"
import { bindingData, lineFromRow, parseTemplateSpec, sameName, UNBOUND } from "./dto"
import type { ReservationUser } from "./reservations"
import { assertAccessIds, resolveAccesses, writeAccesses, type ResolvedAccess } from "./accesses"

type Tx = Prisma.TransactionClient
type BindingInput = ConsoleConfigInput["binding"]
type ConsoleIn = Omit<ConsoleConfigInput, "id"> & { id?: string }
type RelayIn = Omit<RelayChannelInput, "id"> & { id?: string }

// ---------------------------------------------------------------------------------------------------------------------
// Checks

async function assertNameFree(prisma: PrismaClient, name: string, exceptId: string | null): Promise<void> {
  const rows = await prisma.equipment.findMany({ select: { id: true, name: true } })
  if (rows.some((r) => r.id !== exceptId && sameName(r.name, name))) throw conflictError({ name: [domainText.equipmentNameTaken] })
}

/**
 * Resolves the object bindings through W1-A discovery (never builds records itself, §4.4).
 * Absent devices → DEVICE_NOT_FOUND with every affected row in fieldErrors.
 */
function resolveNewBindings(
  rt: Pick<DomainDeps, "serial">,
  rows: Array<{ path: string; binding: BindingInput }>,
): Map<string, ConsoleBindingRecord> {
  const out = new Map<string, ConsoleBindingRecord>()
  const missing: Record<string, string[]> = {}
  for (const r of rows) {
    if (r.binding === null || r.binding === "keep") continue
    const rec = rt.serial.discovery.bindingFor(r.binding.stableKey, r.binding.matchBy)
    if (!rec) missing[r.path] = [domainText.deviceNotFound]
    else out.set(r.path, rec)
  }
  if (Object.keys(missing).length) throw new DomainError("DEVICE_NOT_FOUND", errorMessage("DEVICE_NOT_FOUND"), missing)
  return out
}

/**
 * Final binding keys must be unique inside the save and free in the rest of the DB (the `bindingKey` unique column).
 * `finals` maps a field path to the final key; consoles of `ownEquipmentId` are excluded from the DB check because
 * every one of them is either in the save or deleted by it.
 */
async function assertBindingsFree(prisma: PrismaClient, finals: Array<{ path: string; key: string | null }>, ownEquipmentId: string | null): Promise<void> {
  const errors: Record<string, string[]> = {}
  const seen = new Set<string>()
  for (const f of finals) {
    if (!f.key) continue
    if (seen.has(f.key)) errors[f.path] = [errorMessage("DEVICE_ALREADY_BOUND")]
    seen.add(f.key)
  }
  if (seen.size) {
    const taken = await prisma.serialConsole.findMany({
      where: { bindingKey: { in: [...seen] }, ...(ownEquipmentId ? { equipmentId: { not: ownEquipmentId } } : {}) },
      select: { bindingKey: true, key: true, equipment: { select: { name: true } } },
    })
    const byKey = new Map(taken.map((t) => [t.bindingKey, t]))
    for (const f of finals) {
      const t = f.key ? byKey.get(f.key) : undefined
      if (t) errors[f.path] = [domainFormat.deviceAlreadyBound(t.equipment.name, t.key)]
    }
  }
  if (Object.keys(errors).length) throw new DomainError("DEVICE_ALREADY_BOUND", errorMessage("DEVICE_ALREADY_BOUND"), errors)
}

/** Boards exist, channels are in range and not bound to another equipment (§4.15 step 4). */
async function assertRelaysValid(prisma: PrismaClient, relays: readonly RelayIn[], ownEquipmentId: string | null): Promise<void> {
  if (!relays.length) return
  const boards = new Map((await prisma.relayBoard.findMany({
    where: { id: { in: [...new Set(relays.map((r) => r.boardId))] } }, select: { id: true, name: true, relayCount: true },
  })).map((b) => [b.id, b]))
  const invalid: Record<string, string[]> = {}
  relays.forEach((r, i) => {
    const b = boards.get(r.boardId)
    if (!b) invalid[`relays.${i}.boardId`] = [domainText.boardMissing]
    else if (r.channel > b.relayCount) invalid[`relays.${i}.channel`] = [domainFormat.channelOutOfRange(b.name, b.relayCount)]
  })
  if (Object.keys(invalid).length) throw validationError(invalid)
  const taken = await prisma.relayChannel.findMany({
    where: {
      OR: relays.map((r) => ({ boardId: r.boardId, channel: r.channel })),
      ...(ownEquipmentId ? { equipmentId: { not: ownEquipmentId } } : {}),
    },
    select: { boardId: true, channel: true, equipment: { select: { name: true } } },
  })
  if (!taken.length) return
  const conflicts: Record<string, string[]> = {}
  relays.forEach((r, i) => {
    const t = taken.find((x) => x.boardId === r.boardId && x.channel === r.channel)
    const b = boards.get(r.boardId)
    if (t && b) conflicts[`relays.${i}.channel`] = [domainFormat.channelTakenBy(r.channel, b.name, t.equipment.name)]
  })
  const first = Object.values(conflicts)[0]?.[0]
  throw conflictError(conflicts, first)
}

// ---------------------------------------------------------------------------------------------------------------------
// Row data

function consoleColumns(c: ConsoleIn, position: number) {
  return {
    position, key: c.key, label: c.label,
    baudRate: c.line.baudRate, dataBits: c.line.dataBits, parity: c.line.parity, stopBits: c.line.stopBits, flowControl: c.line.flowControl,
    enterMode: c.enterMode, localEcho: c.localEcho, hupcl: c.hupcl, captureToDisk: c.captureToDisk,
    identifyHostnameRegex: c.identify.hostnameRegex ?? null, identifyBannerRegex: c.identify.bannerRegex ?? null,
  }
}
function relayColumns(r: RelayIn, position: number) {
  return {
    position, key: r.key, label: r.label, purpose: r.purpose, requireConfirm: r.requireConfirm,
    defaultPulseMs: r.defaultPulseMs, boardId: r.boardId, channel: r.channel,
  }
}

function bindingColumnsFor(binding: BindingInput, rec: ConsoleBindingRecord | undefined, now: Date) {
  if (binding === "keep") return {}
  if (binding === null || !rec) return UNBOUND
  return bindingData(rec, now)
}

async function nextPosition(prisma: PrismaClient): Promise<number> {
  const agg = await prisma.equipment.aggregate({ _max: { position: true } })
  const max = agg._max.position ?? 0
  // Positions stay 0 (name order) until someone reorders the Banco; after that, new units go last.
  return max > 0 ? max + 1 : 0
}

// ---------------------------------------------------------------------------------------------------------------------
// createEquipment

export async function createEquipment(input: CreateEquipmentInput, ctx: DomainContext): Promise<{ id: string }> {
  const { rt, actor } = ctx
  const prisma = rt.prisma
  if (input.templateUpdate && !input.templateId) throw validationError({ templateUpdate: [domainText.templateUpdateNeedsTemplate] })
  await assertNameFree(prisma, input.name, null)
  await assertRolesExist(prisma, input.roleIds)
  const template = input.templateId ? await prisma.equipmentTemplate.findUnique({ where: { id: input.templateId } }) : null
  if (input.templateId && !template) throw validationError({ templateId: [domainText.templateMissing] })
  if (input.templateUpdate && template?.source === "file") {
    throw validationError({ templateUpdate: [domainText.templateFromFile(template.sourceFile ?? "plantillas/")] })
  }

  const recs = resolveNewBindings(rt, input.consoles.map((c, i) => ({ path: `consoles.${i}.binding`, binding: c.binding })))
  await assertBindingsFree(prisma, [...recs].map(([path, r]) => ({ path, key: r.bindingKey })), null)
  await assertRelaysValid(prisma, input.relays, null)
  const accesses = await resolveAccesses(rt, null, input.accesses, input.consoles.map((c) => c.key))

  let newSpec: TemplateSpec | null = null
  if (input.templateUpdate && template) {
    // Only slot fields come from the wizard draft; namePattern/skipInterfaces stay (§4.15 step 5).
    const current = parseTemplateSpec(template.spec)
    const parsed = TemplateSpecSchema.safeParse({
      ...current, consoles: input.templateUpdate.consoles, relays: input.templateUpdate.relays,
      ...(input.templateUpdate.accesses ? { accesses: input.templateUpdate.accesses } : {}),
    })
    if (!parsed.success) throw validationError(prefixFieldErrors("templateUpdate", toFieldErrors(parsed.error)))
    newSpec = parsed.data
  }

  const now = new Date()
  const position = await nextPosition(prisma)
  const id = await prisma.$transaction(async (tx) => {
    const eq = await tx.equipment.create({
      data: {
        name: input.name, serialNumber: input.serialNumber, description: input.description, position,
        templateId: template?.id ?? null, templateName: template?.name ?? null,
        roles: { connect: input.roleIds.map((rid) => ({ id: rid })) },
        consoles: {
          create: input.consoles.map((c, i) => ({ ...consoleColumns(c, i), ...bindingColumnsFor(c.binding, recs.get(`consoles.${i}.binding`), now) })),
        },
        relays: { create: input.relays.map((r, i) => relayColumns(r, i)) },
      },
      select: { id: true },
    })
    await writeAccesses(tx, eq.id, accesses)
    if (newSpec && template) {
      await tx.equipmentTemplate.update({ where: { id: template.id }, data: { spec: newSpec, needsReview: false } })
    }
    return eq.id
  })

  await afterCommit(rt.log, "recargar consolas", () => rt.serial.consoles.reloadEquipment(id))
  await afterCommit(rt.log, "recargar relés", () => rt.relays.controller.reload())
  await afterCommit(rt.log, "recargar accesos", () => rt.accesses.reloadEquipment(id))
  await afterCommit(rt.log, "recargar puertos del switch", () => rt.equipnet.reloadUsage())
  rt.bus.publish({ type: "equipment.changed", equipmentId: id, change: "created" }, { kind: "all" })
  if (newSpec && template) {
    rt.audit.record({
      actor, action: "template.update", target: { type: "template", id: template.id, name: template.name },
      detail: { source: "wizard", equipmentId: id, consoles: newSpec.consoles.map((c) => c.key), relays: newSpec.relays.map((r) => r.key) },
    })
  }
  rt.audit.record({
    actor, action: "equipment.create", equipment: { id, name: input.name }, target: { type: "equipment", id, name: input.name },
    detail: {
      template: template?.name ?? null, consoles: input.consoles.map((c) => c.key), relays: input.relays.length, roles: input.roleIds.length,
      accesses: accesses.map((a) => `${a.key}:${a.port}`),
    },
  })
  return { id }
}

// ---------------------------------------------------------------------------------------------------------------------
// updateEquipment

function consoleChanged(row: SerialConsole, c: ConsoleIn, position: number, finalKey: string | null): boolean {
  const line = lineFromRow(row)
  return row.key !== c.key || row.label !== c.label || row.position !== position || JSON.stringify(line) !== JSON.stringify(c.line)
    || row.enterMode !== c.enterMode || row.localEcho !== c.localEcho || row.hupcl !== c.hupcl || row.captureToDisk !== c.captureToDisk
    || (row.identifyHostnameRegex ?? undefined) !== c.identify.hostnameRegex || (row.identifyBannerRegex ?? undefined) !== c.identify.bannerRegex
    || row.bindingKey !== finalKey
}

export async function updateEquipment(input: UpdateEquipmentInput, ctx: DomainContext): Promise<{ id: string }> {
  const { rt, actor } = ctx
  const prisma = rt.prisma
  if (!await equipmentForUser(prisma, ctx.user, input.equipmentId)) throw notFound(domainText.equipmentNotFound)
  const eq = await prisma.equipment.findUniqueOrThrow({
    where: { id: input.equipmentId },
    include: { consoles: true, relays: { include: { board: { select: { name: true } } } }, roles: { select: { id: true, name: true } } },
  })
  await assertNameFree(prisma, input.name, eq.id)
  await assertRolesExist(prisma, input.roleIds)

  const consoleRows = new Map(eq.consoles.map((c) => [c.id, c]))
  const relayRows = new Map(eq.relays.map((r) => [r.id, r]))
  const idErrors: Record<string, string[]> = {}
  const seenIds = new Set<string>()
  input.consoles.forEach((c, i) => {
    if (!c.id) return
    if (!consoleRows.has(c.id) || seenIds.has(c.id)) idErrors[`consoles.${i}.id`] = [domainText.consoleNotInEquipment]
    seenIds.add(c.id)
  })
  input.relays.forEach((r, i) => {
    if (!r.id) return
    if (!relayRows.has(r.id) || seenIds.has(r.id)) idErrors[`relays.${i}.id`] = [domainText.relayNotInEquipment]
    seenIds.add(r.id)
  })
  if (Object.keys(idErrors).length) throw validationError(idErrors)

  const recs = resolveNewBindings(rt, input.consoles.map((c, i) => ({ path: `consoles.${i}.binding`, binding: c.binding })))
  const finalKey = (c: ConsoleIn, i: number): string | null => {
    if (c.binding === "keep") return c.id ? consoleRows.get(c.id)?.bindingKey ?? null : null
    if (c.binding === null) return null
    return recs.get(`consoles.${i}.binding`)?.bindingKey ?? null
  }
  await assertBindingsFree(prisma, input.consoles.map((c, i) => ({ path: `consoles.${i}.binding`, key: finalKey(c, i) })), eq.id)
  await assertRelaysValid(prisma, input.relays, eq.id)
  let accesses: ResolvedAccess[] | null = null
  const accessesBefore = input.accesses ? await prisma.equipmentAccess.findMany({ where: { equipmentId: eq.id }, orderBy: { position: "asc" }, include: { console: { select: { key: true } } } }) : []
  if (input.accesses) {
    await assertAccessIds(prisma, eq.id, input.accesses)
    accesses = await resolveAccesses(rt, eq.id, input.accesses, input.consoles.map((c) => c.key))
  }

  const now = new Date()
  const keptConsoleIds = input.consoles.flatMap((c) => (c.id ? [c.id] : []))
  const keptRelayIds = input.relays.flatMap((r) => (r.id ? [r.id] : []))
  await prisma.$transaction(async (tx) => {
    await tx.serialConsole.deleteMany({ where: { equipmentId: eq.id, id: { notIn: keptConsoleIds } } })
    await tx.relayChannel.deleteMany({ where: { equipmentId: eq.id, id: { notIn: keptRelayIds } } })
    // Phase 1: move kept rows to unique temporaries (positions, keys, channels, and changed bindings).
    for (const [i, c] of input.consoles.entries()) {
      if (!c.id) continue
      await tx.serialConsole.update({
        where: { id: c.id },
        data: { position: -(i + 1), key: `~${c.id}`, ...(c.binding === "keep" ? {} : { bindingKey: null }) },
      })
    }
    for (const [i, r] of input.relays.entries()) {
      if (!r.id) continue
      await tx.relayChannel.update({ where: { id: r.id }, data: { position: -(i + 1), channel: -(i + 1) } })
    }
    await tx.equipment.update({
      where: { id: eq.id },
      data: {
        name: input.name, serialNumber: input.serialNumber, description: input.description,
        roles: { set: input.roleIds.map((rid) => ({ id: rid })) },
      },
    })
    // Phase 2: final values, then the new rows.
    await writeConsoles(tx, eq.id, input.consoles, recs, now)
    for (const [i, r] of input.relays.entries()) {
      if (r.id) await tx.relayChannel.update({ where: { id: r.id }, data: relayColumns(r, i) })
      else await tx.relayChannel.create({ data: { equipmentId: eq.id, ...relayColumns(r, i) } })
    }
    if (accesses) await writeAccesses(tx, eq.id, accesses)
  })

  const detail = updateDiff(eq, input, finalKey)
  if (accesses) {
    const keptIds = new Set(accesses.flatMap((a) => (a.id ? [a.id] : [])))
    const changed = accesses.flatMap((a) => {
      const b = a.id ? accessesBefore.find((x) => x.id === a.id) : undefined
      if (!b) return []
      const same = b.key === a.key && b.label === a.label && b.port === a.port && b.enabled === a.enabled && b.policy === a.policy
        && b.jtagCableSerial === a.jtagCableSerial && b.targetHost === a.targetHost && b.targetPort === a.targetPort
        && b.targetMode === a.targetMode && b.switchPort === a.switchPort && b.sshUser === a.sshUser
        && (b.kind !== "serial" || (b.console?.key ?? null) === a.consoleKey)
      return same ? [] : [b.port === a.port ? a.key : `${a.key}:${b.port}→${a.port}`]
    })
    const diff = {
      added: accesses.filter((a) => !a.id).map((a) => `${a.key}:${a.port}`),
      removed: accessesBefore.filter((b) => !keptIds.has(b.id)).map((b) => `${b.key}:${b.port}`),
      changed,
    }
    if (diff.added.length || diff.removed.length || diff.changed.length) detail.accesses = diff
  }
  await afterCommit(rt.log, "recargar consolas", () => rt.serial.consoles.reloadEquipment(eq.id))
  await afterCommit(rt.log, "recargar relés", () => rt.relays.controller.reload())
  await afterCommit(rt.log, "recargar accesos", () => rt.accesses.reloadEquipment(eq.id))
  await afterCommit(rt.log, "recargar puertos del switch", () => rt.equipnet.reloadUsage())
  rt.bus.publish({ type: "equipment.changed", equipmentId: eq.id, change: "updated" }, { kind: "all" })
  rt.audit.record({ actor, action: "equipment.update", equipment: { id: eq.id, name: input.name }, target: { type: "equipment", id: eq.id, name: input.name }, detail })
  return { id: eq.id }
}

async function writeConsoles(tx: Tx, equipmentId: string, consoles: readonly ConsoleIn[], recs: Map<string, ConsoleBindingRecord>, now: Date): Promise<void> {
  for (const [i, c] of consoles.entries()) {
    const data = { ...consoleColumns(c, i), ...bindingColumnsFor(c.binding, recs.get(`consoles.${i}.binding`), now) }
    if (c.id) await tx.serialConsole.update({ where: { id: c.id }, data })
    else await tx.serialConsole.create({ data: { equipmentId, ...data } })
  }
}

function updateDiff(
  eq: { name: string; serialNumber: string | null; description: string | null; roles: Array<{ id: string; name: string }>
    consoles: SerialConsole[]; relays: Array<{ id: string; key: string | null; label: string; purpose: string; requireConfirm: boolean
      defaultPulseMs: number | null; boardId: string; channel: number; position: number }> },
  input: UpdateEquipmentInput,
  finalKey: (c: ConsoleIn, i: number) => string | null,
): Record<string, JsonValue> {
  const detail: Record<string, JsonValue> = scalarDiff(
    { name: eq.name, serialNumber: eq.serialNumber, description: eq.description },
    { name: input.name, serialNumber: input.serialNumber, description: input.description },
  )
  const beforeRoles = eq.roles.map((r) => r.id).sort()
  const afterRoles = [...new Set(input.roleIds)].sort()
  if (JSON.stringify(beforeRoles) !== JSON.stringify(afterRoles)) detail.roles = { before: beforeRoles, after: afterRoles }
  const kept = new Set(input.consoles.flatMap((c) => (c.id ? [c.id] : [])))
  const consoles = {
    added: input.consoles.filter((c) => !c.id).map((c) => c.key),
    removed: eq.consoles.filter((c) => !kept.has(c.id)).map((c) => c.key),
    changed: input.consoles.flatMap((c, i) => {
      const row = c.id ? eq.consoles.find((x) => x.id === c.id) : undefined
      return row && consoleChanged(row, c, i, finalKey(c, i)) ? [c.key] : []
    }),
  }
  if (consoles.added.length || consoles.removed.length || consoles.changed.length) detail.consoles = consoles
  const keptRelays = new Set(input.relays.flatMap((r) => (r.id ? [r.id] : [])))
  const relays = {
    added: input.relays.filter((r) => !r.id).map((r) => r.label),
    removed: eq.relays.filter((r) => !keptRelays.has(r.id)).map((r) => r.label),
    changed: input.relays.flatMap((r, i) => {
      const row = r.id ? eq.relays.find((x) => x.id === r.id) : undefined
      if (!row) return []
      const same = row.key === r.key && row.label === r.label && row.purpose === r.purpose && row.requireConfirm === r.requireConfirm
        && row.defaultPulseMs === r.defaultPulseMs && row.boardId === r.boardId && row.channel === r.channel && row.position === i
      return same ? [] : [r.label]
    }),
  }
  if (relays.added.length || relays.removed.length || relays.changed.length) detail.relays = relays
  return detail
}

// ---------------------------------------------------------------------------------------------------------------------
// updateEquipmentBindings (Descubrimiento > "Asignar a equipo")

export async function updateEquipmentBindings(input: z.infer<typeof UpdateEquipmentBindingsInputSchema>, ctx: DomainContext): Promise<{ id: string }> {
  const { rt, actor } = ctx
  const prisma = rt.prisma
  if (!await equipmentForUser(prisma, ctx.user, input.equipmentId)) throw notFound(domainText.equipmentNotFound)
  const eq = await prisma.equipment.findUniqueOrThrow({ where: { id: input.equipmentId }, include: { consoles: true } })
  const rows = new Map(eq.consoles.map((c) => [c.id, c]))
  const errors: Record<string, string[]> = {}
  const seen = new Set<string>()
  input.bindings.forEach((b, i) => {
    if (!rows.has(b.consoleId) || seen.has(b.consoleId)) errors[`bindings.${i}.consoleId`] = [domainText.consoleNotInEquipment]
    seen.add(b.consoleId)
  })
  if (Object.keys(errors).length) throw validationError(errors)

  const recs = resolveNewBindings(rt, input.bindings.map((b, i) => ({ path: `bindings.${i}.binding`, binding: b.binding })))
  const changedIds = new Set(input.bindings.map((b) => b.consoleId))
  // A port already held by a console of this equipment that is not part of the request: report it on the field
  // being edited, naming that console, rather than as a generic form error.
  const siblingErrors: Record<string, string[]> = {}
  input.bindings.forEach((b, i) => {
    const key = b.binding ? recs.get(`bindings.${i}.binding`)?.bindingKey ?? null : null
    const sibling = key ? eq.consoles.find((c) => !changedIds.has(c.id) && c.bindingKey === key) : undefined
    if (sibling) siblingErrors[`bindings.${i}.binding`] = [domainFormat.deviceBoundToSibling(sibling.key)]
  })
  if (Object.keys(siblingErrors).length) {
    throw new DomainError("DEVICE_ALREADY_BOUND", errorMessage("DEVICE_ALREADY_BOUND"), siblingErrors)
  }
  const finals = [
    ...input.bindings.map((b, i) => ({ path: `bindings.${i}.binding`, key: b.binding ? recs.get(`bindings.${i}.binding`)?.bindingKey ?? null : null })),
    ...eq.consoles.filter((c) => !changedIds.has(c.id)).map((c) => ({ path: `_form`, key: c.bindingKey })),
  ]
  await assertBindingsFree(prisma, finals, eq.id)

  const now = new Date()
  await prisma.$transaction(async (tx) => {
    for (const b of input.bindings) await tx.serialConsole.update({ where: { id: b.consoleId }, data: { bindingKey: null } })
    for (const [i, b] of input.bindings.entries()) {
      const rec = recs.get(`bindings.${i}.binding`)
      await tx.serialConsole.update({ where: { id: b.consoleId }, data: b.binding && rec ? bindingData(rec, now) : UNBOUND })
    }
  })

  const changes: JsonValue[] = input.bindings.map((b, i) => {
    const row = rows.get(b.consoleId)
    const rec = recs.get(`bindings.${i}.binding`)
    return {
      key: row?.key ?? b.consoleId,
      before: row?.bindingKey ?? null,
      after: rec?.bindingKey ?? null,
      adapter: rec?.adapterLabel ?? null,
      matchBy: rec?.matchBy ?? null,
    }
  })
  await afterCommit(rt.log, "recargar consolas", () => rt.serial.consoles.reloadEquipment(eq.id))
  await afterCommit(rt.log, "recargar accesos", () => rt.accesses.reloadEquipment(eq.id))
  await afterCommit(rt.log, "recargar puertos del switch", () => rt.equipnet.reloadUsage())
  rt.bus.publish({ type: "equipment.changed", equipmentId: eq.id, change: "updated" }, { kind: "all" })
  rt.audit.record({ actor, action: "equipment.bindings", equipment: { id: eq.id, name: eq.name }, target: { type: "equipment", id: eq.id, name: eq.name }, detail: { changes } })
  return { id: eq.id }
}

// ---------------------------------------------------------------------------------------------------------------------
// deleteEquipment

export async function deleteEquipment(input: z.infer<typeof DeleteEquipmentInputSchema>, ctx: DomainContext): Promise<null> {
  const { rt, actor, user } = ctx
  const prisma = rt.prisma
  if (!await equipmentForUser(prisma, user, input.equipmentId)) throw notFound(domainText.equipmentNotFound)
  const eq = await prisma.equipment.findUniqueOrThrow({
    where: { id: input.equipmentId },
    select: { id: true, name: true, _count: { select: { consoles: true, relays: true } } },
  })
  if (input.confirmName !== eq.name) throw validationError({ confirmName: [domainText.confirmNameMismatch] })
  const reservation = rt.reservations.get(eq.id)
  if (reservation && reservation.holderId !== user.id) {
    const details = { holderName: reservation.holderName, expiresAt: reservation.expiresAt }
    throw new DomainError("RESERVED_BY_OTHER", errorMessage("RESERVED_BY_OTHER", details), undefined, details)
  }
  if (reservation) {
    const holder: ReservationUser = { ...user, ip: actor.ip ?? null }
    await rt.reservations.release(eq.id, holder)
  }
  await prisma.equipment.delete({ where: { id: eq.id } })
  // Accesses first: their serial bridges hang off the consoles.
  await afterCommit(rt.log, "recargar accesos", () => rt.accesses.reloadEquipment(eq.id))
  await afterCommit(rt.log, "recargar puertos del switch", () => rt.equipnet.reloadUsage())
  await afterCommit(rt.log, "recargar consolas", () => rt.serial.consoles.reloadEquipment(eq.id))
  await afterCommit(rt.log, "recargar relés", () => rt.relays.controller.reload())
  rt.bus.publish({ type: "equipment.changed", equipmentId: eq.id, change: "deleted" }, { kind: "all" })
  rt.audit.record({
    actor, action: "equipment.delete", equipment: { id: eq.id, name: eq.name }, target: { type: "equipment", id: eq.id, name: eq.name },
    detail: { consoles: eq._count.consoles, relays: eq._count.relays },
  })
  return null
}

// ---------------------------------------------------------------------------------------------------------------------
// reorderEquipment (P2)

export async function reorderEquipment(input: z.infer<typeof ReorderEquipmentInputSchema>, ctx: DomainContext): Promise<null> {
  const { rt, actor } = ctx
  const ids = [...new Set(input.equipmentIds)]
  const rows = await rt.prisma.equipment.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })
  if (rows.length !== ids.length) throw notFound(domainText.equipmentNotFound)
  await rt.prisma.$transaction(ids.map((id, i) => rt.prisma.equipment.update({ where: { id }, data: { position: i + 1 } })))
  for (const id of ids) rt.bus.publish({ type: "equipment.changed", equipmentId: id, change: "updated" }, { kind: "all" })
  const names = new Map(rows.map((r) => [r.id, r.name]))
  rt.audit.record({ actor, action: "equipment.update", detail: { order: ids.map((id) => names.get(id) ?? id) } })
  return null
}
