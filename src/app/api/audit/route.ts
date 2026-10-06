// GET /api/audit (§7.3, W1-C): one page of audit events for "Cargar más" in Auditoría. Admin only.
import { AuditQuerySchema } from "@/lib/contracts/audit"
import { defineRoute } from "@/server/actions/define-route"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export const GET = defineRoute({ auth: "admin", query: AuditQuerySchema, operation: "audit.query" }, async ({ rt, query }) => {
  return Response.json(await rt.audit.query(query))
})
