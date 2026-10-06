// GET /api/audit/export (§7.3, W1-C): CSV of the filtered audit log (limit ignored, at most 100 000 rows). Admin only.
import { AuditQuerySchema } from "@/lib/contracts/audit"
import { domainFormat } from "@/lib/i18n/domain"
import { defineRoute } from "@/server/actions/define-route"
import { AUDIT_EXPORT_MAX_ROWS, auditCsvStream, exportFilters } from "@/server/services/audit-csv"
import { attachmentDisposition, isoDay } from "@/server/services/downloads"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export const GET = defineRoute({ auth: "admin", query: AuditQuerySchema, operation: "audit.export" }, async ({ rt, actor, query }) => {
  const filters = exportFilters(query)
  const stream = auditCsvStream(rt.audit, query, {
    maxRows: AUDIT_EXPORT_MAX_ROWS,
    // Recorded when the export ends, so the export event never appears inside its own file.
    onEnd: (rows, completed) => rt.audit.record({ actor, action: "audit.export", detail: { filters, rows, completed } }),
  })
  return new Response(stream, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": attachmentDisposition(domainFormat.auditExportFileName(isoDay())),
      "cache-control": "no-store",
    },
  })
})
