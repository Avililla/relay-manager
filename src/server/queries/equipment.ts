import "server-only"
// Equipment read side (§7.4, W1-C). Every query checks visibility through src/server/access.ts (admins see everything).
import type { Page } from "@/lib/contracts/common"
import type { AuditEventDTO } from "@/lib/contracts/audit"
import type { EquipmentCardDTO, EquipmentEditDTO, EquipmentWorkspaceDTO } from "@/lib/contracts/equipment"
import { SERIAL_HINT_CHECKS, type HealthCheckDTO } from "@/lib/contracts/system"
import { equipmentForUser } from "@/server/access"
import { DomainError } from "@/server/errors"
import { errorMessage } from "@/lib/i18n/errors"
import { getRuntime } from "@/server/runtime/registry"
import type { AuthUser, Runtime } from "@/server/runtime/types"
import { listBoardChoices } from "@/server/services/board-choices"
import { toAccessDTO, toConsoleDetail, toConsoleSummary, toRelaySummary } from "@/server/services/dto"
import { accessEditContext } from "./accesses"
import { visibleEquipmentIds } from "@/server/services/visibility"

export const EQUIPMENT_ACTIVITY_PAGE = 50

const cardInclude = {
  template: { select: { name: true } },
  roles: { select: { id: true, name: true }, orderBy: { name: "asc" } },
  consoles: { orderBy: { position: "asc" } },
  relays: { orderBy: { position: "asc" }, include: { board: { select: { id: true, name: true } } } },
  accesses: { orderBy: { position: "asc" }, include: { console: { select: { key: true } } } },
} as const

type CardRow = NonNullable<Awaited<ReturnType<typeof loadOne>>>
async function loadOne(rt: Runtime, id: string) {
  return rt.prisma.equipment.findUnique({ where: { id }, include: cardInclude })
}

function baseCard(rt: Runtime, e: CardRow): Omit<EquipmentCardDTO, "consoles"> {
  return {
    id: e.id, name: e.name, serialNumber: e.serialNumber, description: e.description,
    templateId: e.templateId, templateName: e.template?.name ?? e.templateName, position: e.position,
    roles: e.roles.map((r) => ({ id: r.id, name: r.name })),
    relays: relaySummaries(rt, e),
    reservation: rt.reservations.get(e.id),
    accesses: accessSummaries(rt, e),
  }
}

function accessSummaries(rt: Runtime, e: CardRow) {
  if (!e.accesses.length) return []
  const runtimes = rt.accesses.runtimeForEquipment(e.id)
  return e.accesses.map((a) => toAccessDTO(a, runtimes[a.id], (s) => rt.accesses.cableName(s)))
}

function relaySummaries(rt: Runtime, e: CardRow) {
  if (!e.relays.length) return []
  const states = rt.relays.controller.channelStates(e.id)
  return e.relays.map((r) => toRelaySummary(r, rt.relays, states))
}

/** Visible equipment, ordered by position then name (numeric-aware). */
export async function listEquipmentCards(user: AuthUser): Promise<EquipmentCardDTO[]> {
  const rt = getRuntime()
  const ids = await visibleEquipmentIds(rt.prisma, user)
  if (!ids.length) return []
  const rows = await rt.prisma.equipment.findMany({ where: { id: { in: ids } }, include: cardInclude })
  rows.sort((a, b) => a.position - b.position || a.name.localeCompare(b.name, "es", { numeric: true }))
  return rows.map((e) => {
    const runtimes = rt.serial.consoles.runtimeForEquipment(e.id)
    return { ...baseCard(rt, e), consoles: e.consoles.map((c) => toConsoleSummary(c, runtimes[c.id])) }
  })
}

export async function getEquipmentWorkspace(user: AuthUser, id: string): Promise<EquipmentWorkspaceDTO | null> {
  const rt = getRuntime()
  if (!await equipmentForUser(rt.prisma, user, id)) return null
  const e = await loadOne(rt, id)
  if (!e) return null
  const runtimes = rt.serial.consoles.runtimeForEquipment(e.id)
  return {
    ...baseCard(rt, e),
    consoles: e.consoles.map((c) => toConsoleDetail(c, runtimes[c.id])),
    reservationWarningMin: rt.settings.get().reservationWarningMin,
  }
}

async function serialHints(rt: Runtime): Promise<HealthCheckDTO[]> {
  try {
    return await rt.ops.health.run({ only: SERIAL_HINT_CHECKS })
  } catch (err) {
    rt.log.child("serial").warn("No se pudieron obtener las comprobaciones de puertos serie", { error: String(err) })
    return []
  }
}

/** Admin only (non-admins get null; the page redirects to the workspace). */
export async function getEquipmentEdit(user: AuthUser, id: string): Promise<EquipmentEditDTO | null> {
  if (!user.isAdmin) return null
  const rt = getRuntime()
  const e = await loadOne(rt, id)
  if (!e) return null
  const runtimes = rt.serial.consoles.runtimeForEquipment(e.id)
  const [roles, boards, hints] = await Promise.all([
    rt.prisma.role.findMany({ select: { id: true, name: true } }),
    listBoardChoices(rt, { forEquipmentId: e.id }),
    serialHints(rt),
  ])
  return {
    id: e.id, name: e.name, serialNumber: e.serialNumber, description: e.description,
    templateId: e.templateId, templateName: e.template?.name ?? e.templateName,
    roleIds: e.roles.map((r) => r.id),
    consoles: e.consoles.map((c) => toConsoleDetail(c, runtimes[c.id])),
    relays: relaySummaries(rt, e),
    accesses: accessSummaries(rt, e),
    accessContext: await accessEditContext(rt, e.id),
    reservation: rt.reservations.get(e.id),
    roles: roles.sort((a, b) => a.name.localeCompare(b.name, "es")),
    boards,
    serial: rt.serial.discovery.toDTO(),
    serialHints: hints,
    hideJtag: rt.config.serial.hideJtag,
  }
}

/**
 * Audit events of one equipment, 50 per page, newest first (id cursor). IPs are hidden from non-admins.
 * Invisible or missing equipment → NOT_FOUND (the route answers 404).
 */
export async function getEquipmentActivity(user: AuthUser, id: string, cursor?: number | null): Promise<Page<AuditEventDTO>> {
  const rt = getRuntime()
  if (!await equipmentForUser(rt.prisma, user, id)) throw new DomainError("NOT_FOUND", errorMessage("NOT_FOUND"))
  const page = await rt.audit.query({ equipmentId: id, limit: EQUIPMENT_ACTIVITY_PAGE, cursor: cursor ?? undefined })
  return user.isAdmin ? page : { ...page, items: page.items.map((e) => ({ ...e, ip: null })) }
}
