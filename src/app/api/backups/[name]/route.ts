// GET /api/backups/[name] (§7.3, W1-C): download one backup through rt.ops.backups.resolvePath. Admin only, audited.
import fs from "node:fs"
import { z } from "zod"
import { BackupNameSchema } from "@/lib/contracts/system"
import { domainText } from "@/lib/i18n/domain"
import { defineRoute } from "@/server/actions/define-route"
import { DomainError } from "@/server/errors"
import { attachmentDisposition, fileStream } from "@/server/services/downloads"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export const GET = defineRoute(
  { auth: "admin", params: z.object({ name: BackupNameSchema }), operation: "backup.download" },
  async ({ rt, actor, params }) => {
    const file = rt.ops.backups.resolvePath(params.name)
    const stat = file ? await fs.promises.stat(file).catch(() => null) : null
    if (!file || !stat?.isFile()) throw new DomainError("NOT_FOUND", domainText.backupNotFound)
    rt.audit.record({
      actor, action: "backup.download", target: { type: "backup", id: params.name, name: params.name },
      detail: { file: params.name, sizeBytes: stat.size },
    })
    return new Response(fileStream(file), {
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(stat.size),
        "content-disposition": attachmentDisposition(params.name),
        "cache-control": "no-store",
      },
    })
  },
)
