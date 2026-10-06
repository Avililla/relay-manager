// Audit service (§4.2): append-only log with redaction, a sequential write queue and a daily purge.
import type { PrismaClient } from "@/generated/prisma/client"
import type { Prisma } from "@/generated/prisma/client"
import type { JsonValue, Page } from "@/lib/contracts/common"
import type { AuditAction, AuditEventDTO, AuditOutcome, AuditTargetType } from "@/lib/contracts/audit"
import type { Logger } from "@/server/log"
import type { AuditInput, AuditService } from "@/server/runtime/types"

export const REDACTED = "[oculto]"
const SECRET_KEY = /pass|secret|token|authorization|cookie|hash/i
const MAX_DETAIL_BYTES = 8 * 1024
const RETRIES = 3
const RETRY_MS = 200
const PURGE_HOUR = 4
const PURGE_MINUTE = 15

function redactValue(v: JsonValue): JsonValue {
  if (Array.isArray(v)) return v.map(redactValue)
  if (v !== null && typeof v === "object") {
    const out: { [key: string]: JsonValue } = {}
    for (const [k, val] of Object.entries(v)) out[k] = SECRET_KEY.test(k) ? REDACTED : redactValue(val)
    return out
  }
  return v
}

/** Recursively replaces the value of any key matching /pass|secret|token|authorization|cookie|hash/i. */
export function redactDetail(detail: Record<string, JsonValue>): Record<string, JsonValue> {
  return redactValue(detail) as Record<string, JsonValue>
}

/** Serialised detail is limited to 8 KB: larger objects become {"truncated": true}. */
export function limitDetail(detail: Record<string, JsonValue>): Record<string, JsonValue> {
  return Buffer.byteLength(JSON.stringify(detail), "utf8") > MAX_DETAIL_BYTES ? { truncated: true } : detail
}

type AuditRow = {
  id: number; at: Date; actorKind: string; actorId: string | null; actorName: string; ip: string | null; action: string; outcome: string
  equipmentId: string | null; equipmentName: string | null; targetType: string | null; targetId: string | null; targetName: string | null
  detail: unknown
}

export function toAuditEventDTO(r: AuditRow): AuditEventDTO {
  return {
    id: r.id,
    at: r.at.toISOString(),
    actorKind: r.actorKind === "system" || r.actorKind === "cli" ? r.actorKind : "user",
    actorId: r.actorId,
    actorName: r.actorName,
    ip: r.ip,
    action: r.action as AuditAction,
    outcome: (r.outcome === "denied" || r.outcome === "error" ? r.outcome : "ok") as AuditOutcome,
    equipmentId: r.equipmentId,
    equipmentName: r.equipmentName,
    targetType: (r.targetType as AuditTargetType | null) ?? null,
    targetId: r.targetId,
    targetName: r.targetName,
    detail: (r.detail ?? null) as JsonValue | null,
  }
}

function toRow(input: AuditInput): Prisma.AuditEventCreateInput {
  const detail = input.detail ? limitDetail(redactDetail(input.detail)) : undefined
  return {
    actorKind: input.actor.kind,
    actorId: input.actor.id,
    actorName: input.actor.name,
    ip: input.actor.ip ?? null,
    action: input.action,
    outcome: input.outcome ?? "ok",
    equipmentId: input.equipment?.id ?? null,
    equipmentName: input.equipment?.name ?? null,
    targetType: input.target?.type ?? null,
    targetId: input.target?.id ?? null,
    targetName: input.target?.name ?? null,
    detail: detail as Prisma.InputJsonValue | undefined,
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function msUntilNext(hour: number, minute: number, from: Date = new Date()): number {
  const next = new Date(from)
  next.setHours(hour, minute, 0, 0)
  if (next.getTime() <= from.getTime()) next.setDate(next.getDate() + 1)
  return next.getTime() - from.getTime()
}

export function createAuditService(deps: { prisma: PrismaClient; log: Logger; retentionDays?: () => number }): AuditService {
  const log = deps.log.child("audit")
  const queue: AuditInput[] = []
  let draining: Promise<void> | null = null
  let purgeTimer: ReturnType<typeof setTimeout> | null = null
  let stopped = false

  async function write(input: AuditInput): Promise<void> {
    const data = toRow(input)
    for (let attempt = 0; ; attempt++) {
      try {
        await deps.prisma.auditEvent.create({ data })
        return
      } catch (err) {
        if (attempt >= RETRIES) {
          log.error("No se pudo registrar un evento de auditoría: se descarta", { action: input.action, err })
          return
        }
        await sleep(RETRY_MS)
      }
    }
  }

  async function run(): Promise<void> {
    // Yield first, so `draining` is assigned before the finally block can clear it.
    await null
    try {
      while (queue.length) {
        const next = queue.shift()
        if (next) await write(next)
      }
    } finally {
      draining = null
    }
  }

  /** Writes the queue sequentially; one drain loop at a time. */
  function drain(): Promise<void> {
    if (draining) return draining
    if (!queue.length) return Promise.resolve()
    draining = run()
    return draining
  }

  async function purgeOlderThan(days: number): Promise<number> {
    const cutoff = new Date(Date.now() - days * 86_400_000)
    const [, deleted] = await deps.prisma.$transaction([
      deps.prisma.settings.update({ where: { id: "global" }, data: { auditPurgeUnlocked: true } }),
      deps.prisma.auditEvent.deleteMany({ where: { at: { lt: cutoff } } }),
      deps.prisma.settings.update({ where: { id: "global" }, data: { auditPurgeUnlocked: false } }),
    ])
    queue.push({ actor: { kind: "system", id: null, name: "sistema" }, action: "audit.purge", detail: { deleted: deleted.count, days } })
    void drain()
    return deleted.count
  }

  function schedulePurge(): void {
    if (stopped || !deps.retentionDays) return
    purgeTimer = setTimeout(() => {
      const days = deps.retentionDays?.() ?? 365
      purgeOlderThan(days)
        .then((n) => { if (n) log.info("Auditoría antigua borrada", { eventos: n, dias: days }) })
        .catch((err: unknown) => log.error("Error al borrar la auditoría antigua", { err }))
        .finally(schedulePurge)
    }, msUntilNext(PURGE_HOUR, PURGE_MINUTE))
    purgeTimer.unref?.()
  }

  return {
    record(input) {
      try {
        queue.push(input)
        void drain()
      } catch (err) {
        log.error("Error al encolar un evento de auditoría", { err })
      }
    },
    async recordNow(input) {
      await drain()
      await write(input)
    },
    async flush() {
      while (queue.length || draining) await drain()
    },
    async query(q): Promise<Page<AuditEventDTO>> {
      const where: Prisma.AuditEventWhereInput = {}
      if (q.from || q.to) where.at = { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lte: new Date(q.to) } : {}) }
      if (q.actorId) where.actorId = q.actorId
      if (q.equipmentId) where.equipmentId = q.equipmentId
      if (q.action) where.action = q.action
      else if (q.category) where.action = { startsWith: `${q.category}.` }
      if (q.outcome) where.outcome = q.outcome
      if (q.cursor) where.id = { lt: q.cursor }
      const rows = await deps.prisma.auditEvent.findMany({ where, orderBy: { id: "desc" }, take: q.limit + 1 })
      const items = rows.slice(0, q.limit).map(toAuditEventDTO)
      return { items, nextCursor: rows.length > q.limit ? String(items[items.length - 1].id) : null }
    },
    purgeOlderThan,
    start() {
      stopped = false
      if (!purgeTimer) schedulePurge()
    },
    stop() {
      stopped = true
      if (purgeTimer) clearTimeout(purgeTimer)
      purgeTimer = null
    },
  }
}
