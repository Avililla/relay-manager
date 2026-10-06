import type { PrismaClient } from "@/generated/prisma/client"

/** Append-only audit log (D27). Idempotent; lives outside the migrations so `db:check` never sees it (§3.2). */
const STATEMENTS = [
  `CREATE TRIGGER IF NOT EXISTS "AuditEvent_no_update" BEFORE UPDATE ON "AuditEvent"
BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;`,
  `CREATE TRIGGER IF NOT EXISTS "AuditEvent_no_delete" BEFORE DELETE ON "AuditEvent"
WHEN COALESCE((SELECT "auditPurgeUnlocked" FROM "Settings" WHERE "id" = 'global'), 0) = 0
BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;`,
]

export async function ensureDbInvariants(prisma: PrismaClient): Promise<void> {
  for (const sql of STATEMENTS) await prisma.$executeRawUnsafe(sql)
}
