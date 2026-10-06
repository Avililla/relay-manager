// GET /api/config/export (§7.3, W1-C): configuration JSON (no users, no board passwords). Admin only.
import { domainFormat } from "@/lib/i18n/domain"
import { defineRoute } from "@/server/actions/define-route"
import { exportConfig } from "@/server/services/config-io"
import { attachmentDisposition, isoDay } from "@/server/services/downloads"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export const GET = defineRoute({ auth: "admin", operation: "config.export" }, async ({ rt, actor }) => {
  const cfg = await exportConfig(rt.prisma, { appVersion: rt.config.build.version })
  const name = domainFormat.configExportFileName(isoDay())
  rt.audit.record({
    actor, action: "config.export", target: { type: "config", name },
    detail: { roles: cfg.roles.length, templates: cfg.templates.length, boards: cfg.boards.length, equipment: cfg.equipment.length },
  })
  return new Response(JSON.stringify(cfg, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": attachmentDisposition(name),
      "cache-control": "no-store",
    },
  })
})
