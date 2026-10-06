// Audit rows written by CLI commands (another process than the server). It uses better-sqlite3 directly, so it works on a
// DB whose schema is older than this build (restore, pre-upgrade backup) and needs no Prisma client.
import Database from "better-sqlite3"
import { limitDetail, redactDetail } from "@/server/audit/service"
import type { AuditInput } from "@/server/runtime/types"

/** Prisma's SQLite DateTime text format ("2026-09-23T17:21:59.525+00:00"). */
export function prismaDateTime(d: Date): string {
  return d.toISOString().replace(/Z$/, "+00:00")
}

/** Appends one AuditEvent row (same redaction and 8 KB cap as the audit service). Throws on failure. */
export function writeAuditRow(dbFile: string, input: AuditInput, at: Date = new Date()): void {
  const detail = input.detail ? JSON.stringify(limitDetail(redactDetail(input.detail))) : null
  const db = new Database(dbFile, { fileMustExist: true })
  try {
    db.pragma("busy_timeout = 5000")
    db.prepare(
      `INSERT INTO "AuditEvent" ("at", "actorKind", "actorId", "actorName", "ip", "action", "outcome", "equipmentId", "equipmentName",
        "targetType", "targetId", "targetName", "detail") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      prismaDateTime(at), input.actor.kind, input.actor.id, input.actor.name, input.actor.ip ?? null, input.action, input.outcome ?? "ok",
      input.equipment?.id ?? null, input.equipment?.name ?? null,
      input.target?.type ?? null, input.target?.id ?? null, input.target?.name ?? null, detail,
    )
  } finally {
    db.close()
  }
}
