import "server-only"
// Audit read side (§7.4, W1-C). Admin pages call requireAdmin() first.
import type { Page } from "@/lib/contracts/common"
import type { AuditEventDTO, AuditQuery } from "@/lib/contracts/audit"
import { getRuntime } from "@/server/runtime/registry"

export async function queryAudit(q: AuditQuery): Promise<Page<AuditEventDTO>> {
  return getRuntime().audit.query(q)
}
