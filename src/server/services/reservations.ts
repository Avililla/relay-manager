// Reservation service (§4.11, W1-C). Server-authoritative: the DB row is the truth, guarded by conditional
// updates (compare-and-set); the in-memory cache answers isHolder() synchronously. Lives in the runtime registry.
import type { ReservationCause, ReservationDTO } from "@/lib/contracts/reservations"
import { domainFormat } from "@/lib/i18n/domain"
import { errorMessage } from "@/lib/i18n/errors"
import { equipmentForUser } from "@/server/access"
import { DomainError } from "@/server/errors"
import {
  SYSTEM_ACTOR, type ActorRef, type AuthUser, type ReservationChange, type ReservationDeps, type ReservationService,
} from "@/server/runtime/types"

export const RESERVATION_SWEEP_MS = 5_000
export const RESERVATION_ACCESS_SWEEP_MS = 30_000
export const TOUCH_THROTTLE_MS = 60_000
const MAX_CAS_ATTEMPTS = 4

/**
 * The frozen interface passes an AuthUser without the client IP. Actions pass `{ ...user, ip }` so that audit rows
 * carry the socket address (D38); the extra field is optional and read structurally.
 */
export type ReservationUser = AuthUser & { ip?: string | null }

export interface ReservationServiceInternal extends ReservationService {
  /** Expires every reservation whose expiresAt has passed (the 5 s sweeper). Returns the number expired. */
  sweepExpired(): Promise<number>
  /** Releases the reservations of removed users and of holders who lost access (the 30 s sweeper). */
  sweepAccess(): Promise<number>
  /** Resolves when no touch or sweep is in flight (tests and shutdown). */
  idle(): Promise<void>
}

interface Entry { dto: ReservationDTO; equipmentName: string }

const holderSelect = { id: true, name: true, username: true } as const
const rowSelect = {
  id: true, name: true, reservedById: true, reservedAt: true, reservationExpiresAt: true, reservationNote: true,
  reservedBy: { select: holderSelect },
} as const

interface Row {
  id: string; name: string; reservedById: string | null; reservedAt: Date | null; reservationExpiresAt: Date | null
  reservationNote: string | null; reservedBy: { id: string; name: string; username: string } | null
}

function rowToEntry(r: Row): Entry | null {
  if (!r.reservedById || !r.reservedBy || !r.reservationExpiresAt) return null
  return {
    equipmentName: r.name,
    dto: {
      equipmentId: r.id,
      holderId: r.reservedById,
      holderName: r.reservedBy.name,
      holderUsername: r.reservedBy.username,
      reservedAt: (r.reservedAt ?? r.reservationExpiresAt).toISOString(),
      expiresAt: r.reservationExpiresAt.toISOString(),
      note: r.reservationNote,
    },
  }
}

function actorOf(user: ReservationUser): ActorRef {
  return { kind: "user", id: user.id, name: user.username, ip: user.ip ?? null }
}

const CLEARED = { reservedById: null, reservedAt: null, reservationExpiresAt: null, reservationNote: null } as const

export function createReservationService(deps: ReservationDeps): ReservationServiceInternal {
  const log = deps.log.child("reservations")
  const now = deps.now ?? (() => new Date())
  const cache = new Map<string, Entry>()
  const lastTouch = new Map<string, number>()
  const listeners = new Set<(change: ReservationChange) => void>()
  const inflight = new Set<Promise<unknown>>()
  let sweepTimer: ReturnType<typeof setInterval> | null = null
  let accessTimer: ReturnType<typeof setInterval> | null = null
  let sweeping = false
  let accessSweeping = false

  const track = <T>(p: Promise<T>): Promise<T> => {
    inflight.add(p)
    void p.finally(() => inflight.delete(p)).catch(() => {})
    return p
  }
  const timeoutMs = () => deps.settings.get().reservationTimeoutMin * 60_000
  const valid = (e: Entry | undefined, at: Date = now()): e is Entry => !!e && Date.parse(e.dto.expiresAt) > at.getTime()

  function fanOut(equipmentId: string, equipmentName: string, before: ReservationDTO | null, after: ReservationDTO | null,
    cause: ReservationCause, by: ActorRef, byName: string | null): void {
    if (after) cache.set(equipmentId, { dto: after, equipmentName })
    else cache.delete(equipmentId)
    for (const l of [...listeners]) {
      try {
        l({ equipmentId, before, after, cause, by })
      } catch (err) {
        log.error("Error en un suscriptor de reservas", { err })
      }
    }
    deps.bus.publish(
      { type: "reservation.changed", equipmentId, equipmentName, reservation: after, cause, byName, serverNow: now().toISOString() },
      { kind: "equipment", equipmentId },
    )
  }

  async function readRow(equipmentId: string): Promise<Row | null> {
    return deps.prisma.equipment.findUnique({ where: { id: equipmentId }, select: rowSelect })
  }

  async function assertVisible(equipmentId: string, user: AuthUser): Promise<void> {
    const ref = await equipmentForUser(deps.prisma, user, equipmentId)
    if (!ref) throw new DomainError("NOT_FOUND", errorMessage("NOT_FOUND"))
  }

  function reservedByOther(entry: Entry): DomainError {
    const details = { holderName: entry.dto.holderName, expiresAt: entry.dto.expiresAt }
    return new DomainError("RESERVED_BY_OTHER", errorMessage("RESERVED_BY_OTHER", details), undefined, details)
  }

  /** Emits reservation.expire (audit + fan-out) for a reservation that this process has just cleared. */
  function emitExpired(prev: Entry): void {
    deps.audit.record({
      actor: SYSTEM_ACTOR, action: "reservation.expire",
      equipment: { id: prev.dto.equipmentId, name: prev.equipmentName },
      detail: { previousHolder: prev.dto.holderUsername, expiresAt: prev.dto.expiresAt },
    })
    lastTouch.delete(prev.dto.equipmentId)
    fanOut(prev.dto.equipmentId, prev.equipmentName, prev.dto, null, "expire", SYSTEM_ACTOR, null)
  }

  async function reserve(equipmentId: string, user: ReservationUser, opts: { note?: string | null; ip?: string | null } = {}): Promise<ReservationDTO> {
    await assertVisible(equipmentId, user)
    const holder = await deps.prisma.user.findUnique({ where: { id: user.id }, select: { disabled: true, name: true, username: true } })
    if (!holder || holder.disabled) throw new DomainError("FORBIDDEN", errorMessage("FORBIDDEN"))
    const actor: ActorRef = { ...actorOf(user), ip: opts.ip ?? user.ip ?? null }
    const note = opts.note ?? null

    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
      const row = await readRow(equipmentId)
      if (!row) throw new DomainError("NOT_FOUND", errorMessage("NOT_FOUND"))
      const current = rowToEntry(row)
      const t = now()
      const expiresAt = new Date(t.getTime() + timeoutMs())

      if (current && valid(current, t) && current.dto.holderId !== user.id) throw reservedByOther(current)

      if (current && valid(current, t)) {
        // Rule 3: own unit → renew (keeps reservedAt) and update the note.
        const res = await deps.prisma.equipment.updateMany({
          where: { id: equipmentId, reservedById: user.id, reservationExpiresAt: { gt: t } },
          data: { reservationExpiresAt: expiresAt, reservationNote: note },
        })
        if (res.count !== 1) continue
        const after: ReservationDTO = { ...current.dto, expiresAt: expiresAt.toISOString(), note }
        deps.audit.record({ actor, action: "reservation.renew", equipment: { id: equipmentId, name: row.name }, detail: { source: "button", note, expiresAt: after.expiresAt } })
        fanOut(equipmentId, row.name, current.dto, after, "renew", actor, holder.name)
        return after
      }

      // Free, or expired (held by anyone): take it over with a compare-and-set on the observed state. DateTime columns
      // are compared by range, never by equality (rows written outside Prisma may use another ISO text format).
      const where = row.reservedById
        ? { id: equipmentId, reservedById: row.reservedById, OR: [{ reservationExpiresAt: null }, { reservationExpiresAt: { lte: t } }] }
        : { id: equipmentId, reservedById: null }
      const res = await deps.prisma.equipment.updateMany({
        where,
        data: { reservedById: user.id, reservedAt: t, reservationExpiresAt: expiresAt, reservationNote: note },
      })
      if (res.count !== 1) continue
      const prev = current ?? (row.reservedById ? cache.get(equipmentId) : undefined)
      if (prev) emitExpired(prev)
      const after: ReservationDTO = {
        equipmentId, holderId: user.id, holderName: holder.name, holderUsername: holder.username,
        reservedAt: t.toISOString(), expiresAt: expiresAt.toISOString(), note,
      }
      deps.audit.record({ actor, action: "reservation.reserve", equipment: { id: equipmentId, name: row.name }, detail: { note, expiresAt: after.expiresAt } })
      fanOut(equipmentId, row.name, null, after, "reserve", actor, holder.name)
      return after
    }
    // Lost every compare-and-set: somebody else keeps winning.
    const row = await readRow(equipmentId)
    const cur = row ? rowToEntry(row) : null
    if (cur) throw reservedByOther(cur)
    throw new DomainError("CONFLICT", errorMessage("CONFLICT"))
  }

  async function renew(equipmentId: string, user: ReservationUser, source: "button" | "console" | "relay"): Promise<ReservationDTO> {
    await assertVisible(equipmentId, user)
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
      const row = await readRow(equipmentId)
      if (!row) throw new DomainError("NOT_FOUND", errorMessage("NOT_FOUND"))
      const current = rowToEntry(row)
      const t = now()
      if (!current || !valid(current, t)) throw new DomainError("NOT_RESERVED", errorMessage("NOT_RESERVED"))
      if (current.dto.holderId !== user.id) throw new DomainError("NOT_HOLDER", errorMessage("NOT_HOLDER"))
      const expiresAt = new Date(t.getTime() + timeoutMs())
      const res = await deps.prisma.equipment.updateMany({
        where: { id: equipmentId, reservedById: user.id, reservationExpiresAt: { gt: t } },
        data: { reservationExpiresAt: expiresAt },
      })
      if (res.count !== 1) continue
      const after: ReservationDTO = { ...current.dto, expiresAt: expiresAt.toISOString() }
      const actor = actorOf(user)
      if (source === "button") {
        deps.audit.record({ actor, action: "reservation.renew", equipment: { id: equipmentId, name: row.name }, detail: { source, expiresAt: after.expiresAt } })
      }
      fanOut(equipmentId, row.name, current.dto, after, "renew", actor, current.dto.holderName)
      return after
    }
    throw new DomainError("CONFLICT", errorMessage("CONFLICT"))
  }

  function touch(equipmentId: string, userId: string, source: "console" | "relay" | "access"): void {
    const entry = cache.get(equipmentId)
    const t = now()
    if (!valid(entry, t) || entry.dto.holderId !== userId) return
    const last = lastTouch.get(equipmentId)
    if (last !== undefined && t.getTime() - last < TOUCH_THROTTLE_MS) return
    lastTouch.set(equipmentId, t.getTime())
    const expiresAt = new Date(t.getTime() + timeoutMs())
    void track((async () => {
      try {
        const res = await deps.prisma.equipment.updateMany({
          where: { id: equipmentId, reservedById: userId, reservationExpiresAt: { gt: t } },
          data: { reservationExpiresAt: expiresAt },
        })
        if (res.count !== 1) return
        const cur = cache.get(equipmentId)
        if (!cur || cur.dto.holderId !== userId) return
        const after: ReservationDTO = { ...cur.dto, expiresAt: expiresAt.toISOString() }
        const by: ActorRef = { kind: "user", id: userId, name: cur.dto.holderUsername }
        fanOut(equipmentId, cur.equipmentName, cur.dto, after, "renew", by, cur.dto.holderName)
      } catch (err) {
        log.error("Error al renovar una reserva por actividad", { source, err })
      }
    })())
  }

  async function release(equipmentId: string, user: ReservationUser): Promise<void> {
    await assertVisible(equipmentId, user)
    const row = await readRow(equipmentId)
    if (!row) throw new DomainError("NOT_FOUND", errorMessage("NOT_FOUND"))
    const current = rowToEntry(row)
    if (!current || current.dto.holderId !== user.id) throw new DomainError("NOT_HOLDER", errorMessage("NOT_HOLDER"))
    const res = await deps.prisma.equipment.updateMany({ where: { id: equipmentId, reservedById: user.id }, data: CLEARED })
    if (res.count !== 1) throw new DomainError("NOT_HOLDER", errorMessage("NOT_HOLDER"))
    const actor = actorOf(user)
    lastTouch.delete(equipmentId)
    deps.audit.record({ actor, action: "reservation.release", equipment: { id: equipmentId, name: row.name } })
    fanOut(equipmentId, row.name, current.dto, null, "release", actor, current.dto.holderName)
  }

  async function forceRelease(equipmentId: string, admin: ReservationUser, reason: string): Promise<void> {
    if (!admin.isAdmin) throw new DomainError("FORBIDDEN", errorMessage("FORBIDDEN"))
    const row = await readRow(equipmentId)
    if (!row) throw new DomainError("NOT_FOUND", errorMessage("NOT_FOUND"))
    const current = rowToEntry(row)
    if (!current) throw new DomainError("NOT_RESERVED", errorMessage("NOT_RESERVED"))
    const res = await deps.prisma.equipment.updateMany({ where: { id: equipmentId, reservedById: current.dto.holderId }, data: CLEARED })
    if (res.count !== 1) throw new DomainError("NOT_RESERVED", errorMessage("NOT_RESERVED"))
    const actor = actorOf(admin)
    lastTouch.delete(equipmentId)
    deps.audit.record({
      actor, action: "reservation.force-release", equipment: { id: equipmentId, name: row.name },
      target: { type: "user", id: current.dto.holderId, name: current.dto.holderUsername },
      detail: { reason, previousHolder: current.dto.holderUsername },
    })
    if (current.dto.holderId !== admin.id) {
      deps.bus.publish(
        { type: "toast", level: "warn", message: domainFormat.forceReleaseToast(admin.name, row.name, reason) },
        { kind: "user", userId: current.dto.holderId },
      )
    }
    fanOut(equipmentId, row.name, current.dto, null, "force-release", actor, admin.name)
  }

  /** Clears one reservation on behalf of the system (user removed, access lost). */
  async function systemRelease(entry: Entry, cause: "user-removed" | "access-lost", reason: string): Promise<boolean> {
    const res = await deps.prisma.equipment.updateMany({
      where: { id: entry.dto.equipmentId, reservedById: entry.dto.holderId },
      data: CLEARED,
    })
    if (res.count !== 1) {
      cache.delete(entry.dto.equipmentId)
      return false
    }
    lastTouch.delete(entry.dto.equipmentId)
    deps.audit.record({
      actor: SYSTEM_ACTOR, action: "reservation.force-release",
      equipment: { id: entry.dto.equipmentId, name: entry.equipmentName },
      target: { type: "user", id: entry.dto.holderId, name: entry.dto.holderUsername },
      detail: { cause, reason, previousHolder: entry.dto.holderUsername },
    })
    fanOut(entry.dto.equipmentId, entry.equipmentName, entry.dto, null, cause, SYSTEM_ACTOR, null)
    return true
  }

  async function releaseAllForUser(userId: string, cause: "user-disabled" | "user-deleted"): Promise<number> {
    const rows = await deps.prisma.equipment.findMany({ where: { reservedById: userId }, select: rowSelect })
    let n = 0
    for (const r of rows) {
      const e = rowToEntry(r)
      if (e && await systemRelease(e, "user-removed", cause)) n++
    }
    for (const [id, e] of cache) if (e.dto.holderId === userId) cache.delete(id)
    return n
  }

  async function sweepExpired(): Promise<number> {
    if (sweeping) return 0
    sweeping = true
    try {
      const t = now()
      let n = 0
      for (const e of [...cache.values()]) {
        if (Date.parse(e.dto.expiresAt) > t.getTime()) continue
        const res = await deps.prisma.equipment.updateMany({
          where: { id: e.dto.equipmentId, reservedById: e.dto.holderId, reservationExpiresAt: { lte: t } },
          data: CLEARED,
        })
        if (res.count === 1) {
          emitExpired(e)
          n++
        } else {
          // The row changed under us (renewed, released, taken over or deleted): resync this entry.
          const row = await readRow(e.dto.equipmentId)
          const fresh = row ? rowToEntry(row) : null
          if (fresh) cache.set(e.dto.equipmentId, fresh)
          else cache.delete(e.dto.equipmentId)
        }
      }
      return n
    } catch (err) {
      log.error("Error al caducar reservas", { err })
      return 0
    } finally {
      sweeping = false
    }
  }

  async function sweepAccess(): Promise<number> {
    if (accessSweeping || !cache.size) return 0
    accessSweeping = true
    try {
      const entries = [...cache.values()]
      const users = await deps.prisma.user.findMany({
        where: { id: { in: [...new Set(entries.map((e) => e.dto.holderId))] } },
        select: { id: true, isAdmin: true, disabled: true, roles: { select: { id: true } } },
      })
      const byId = new Map(users.map((u) => [u.id, u]))
      let n = 0
      for (const e of entries) {
        if (cache.get(e.dto.equipmentId) !== e) continue
        const u = byId.get(e.dto.holderId)
        if (!u || u.disabled) {
          if (await systemRelease(e, "user-removed", u ? "user-disabled" : "user-deleted")) n++
          continue
        }
        const exists = await deps.prisma.equipment.findUnique({ where: { id: e.dto.equipmentId }, select: { id: true } })
        if (!exists) {
          cache.delete(e.dto.equipmentId)
          continue
        }
        const ref = await equipmentForUser(deps.prisma, { isAdmin: u.isAdmin, roleIds: u.roles.map((r) => r.id) }, e.dto.equipmentId)
        if (!ref && await systemRelease(e, "access-lost", "access-lost")) n++
      }
      return n
    } catch (err) {
      log.error("Error al revisar el acceso de las reservas", { err })
      return 0
    } finally {
      accessSweeping = false
    }
  }

  return {
    async start() {
      const rows = await deps.prisma.equipment.findMany({ where: { reservedById: { not: null } }, select: rowSelect })
      cache.clear()
      for (const r of rows) {
        const e = rowToEntry(r)
        if (e) cache.set(r.id, e)
      }
      if (!sweepTimer) {
        sweepTimer = setInterval(() => { void track(sweepExpired()) }, RESERVATION_SWEEP_MS)
        sweepTimer.unref?.()
      }
      if (!accessTimer) {
        accessTimer = setInterval(() => { void track(sweepAccess()) }, RESERVATION_ACCESS_SWEEP_MS)
        accessTimer.unref?.()
      }
    },
    stop() {
      if (sweepTimer) clearInterval(sweepTimer)
      if (accessTimer) clearInterval(accessTimer)
      sweepTimer = null
      accessTimer = null
    },
    get(equipmentId) {
      const e = cache.get(equipmentId)
      return valid(e) ? e.dto : null
    },
    list() {
      const t = now()
      return [...cache.values()].filter((e) => valid(e, t)).map((e) => e.dto)
    },
    isHolder(equipmentId, userId) {
      const e = cache.get(equipmentId)
      return valid(e) && e.dto.holderId === userId
    },
    reserve,
    renew,
    touch,
    release,
    forceRelease,
    releaseAllForUser,
    onChange(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    sweepExpired: () => track(sweepExpired()),
    sweepAccess: () => track(sweepAccess()),
    async idle() {
      while (inflight.size) await Promise.allSettled([...inflight])
    },
  }
}
