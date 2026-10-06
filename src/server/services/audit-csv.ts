// Audit CSV export (§7.3 /api/audit/export): UTF-8 BOM, ";" separator, RFC 4180 quoting, formula neutralisation.
import type { JsonValue } from "@/lib/contracts/common"
import type { AuditEventDTO, AuditQuery } from "@/lib/contracts/audit"
import { AUDIT_CSV_COLUMNS } from "@/lib/i18n/domain"
import type { AuditService } from "@/server/runtime/types"

export const AUDIT_EXPORT_MAX_ROWS = 100_000
const PAGE_SIZE = 1_000
const BOM = "﻿"
const EOL = "\r\n"

/** A cell whose first character is =, +, -, @, TAB or CR is prefixed with ' so spreadsheets never evaluate it. */
export function neutralizeCell(v: string): string {
  return /^[=+\-@\t\r]/.test(v) ? `'${v}` : v
}

/** Neutralises, then quotes per RFC 4180 when the cell holds the separator, a quote or a line break. */
export function csvCell(v: string | null | undefined): string {
  const n = neutralizeCell(v ?? "")
  return /[;"\r\n]/.test(n) ? `"${n.replaceAll('"', '""')}"` : n
}

export function auditCsvRow(e: AuditEventDTO): string {
  const target = e.targetType ? `${e.targetType}:${e.targetName ?? e.targetId ?? ""}` : (e.targetName ?? e.targetId ?? "")
  const detail = e.detail === null ? "" : JSON.stringify(e.detail)
  return [e.at, e.actorName, e.action, e.outcome, e.equipmentName, target, e.ip, detail].map(csvCell).join(";")
}

/** Filters worth recording in the audit.export event (undefined keys dropped; limit and cursor ignored). */
export function exportFilters(q: AuditQuery): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {}
  for (const k of ["from", "to", "actorId", "equipmentId", "category", "action", "outcome"] as const) {
    const v = q[k]
    if (v !== undefined) out[k] = v
  }
  return out
}

/**
 * Streams every matching event (newest first, at most `maxRows`), paging through AuditService.query with an id cursor.
 * `onEnd(rows, completed)` runs once, when the stream ends or is cancelled.
 */
export function auditCsvStream(
  audit: Pick<AuditService, "query">,
  q: AuditQuery,
  opts: { maxRows?: number; pageSize?: number; onEnd?: (rows: number, completed: boolean) => void } = {},
): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  const maxRows = opts.maxRows ?? AUDIT_EXPORT_MAX_ROWS
  const pageSize = opts.pageSize ?? PAGE_SIZE
  const base: AuditQuery = { ...q, cursor: undefined }
  let cursor: number | undefined
  let rows = 0
  let started = false
  let ended = false
  const end = (completed: boolean) => {
    if (ended) return
    ended = true
    opts.onEnd?.(rows, completed)
  }
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (!started) {
          started = true
          controller.enqueue(enc.encode(BOM + AUDIT_CSV_COLUMNS.join(";") + EOL))
          return
        }
        const limit = Math.min(pageSize, maxRows - rows)
        const page = limit > 0 ? await audit.query({ ...base, cursor, limit }) : { items: [], nextCursor: null }
        if (page.items.length) {
          rows += page.items.length
          controller.enqueue(enc.encode(page.items.map((e) => auditCsvRow(e) + EOL).join("")))
        }
        if (!page.nextCursor || rows >= maxRows || !page.items.length) {
          controller.close()
          end(true)
          return
        }
        cursor = Number(page.nextCursor)
      } catch (err) {
        controller.error(err)
        end(false)
      }
    },
    cancel() {
      end(false)
    },
  })
}
