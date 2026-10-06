// GET /api/equipnet/switch-backup: the switch's own configuration backup taken before the last change by the app
// ("Red de equipos"). It contains the switch credentials: admins only, audited.
import fs from "node:fs"
import path from "node:path"
import { defineRoute } from "@/server/actions/define-route"
import { DomainError } from "@/server/errors"
import { attachmentDisposition, fileStream } from "@/server/services/downloads"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export const GET = defineRoute({ auth: "admin", operation: "equipnet.switch.backup" }, async ({ rt, actor }) => {
  const file = rt.equipnet.backupFile()
  const stat = file ? await fs.promises.stat(file).catch(() => null) : null
  if (!file || !stat?.isFile()) throw new DomainError("NOT_FOUND", "No hay ninguna copia de la configuración del switch")
  const name = path.basename(file)
  rt.audit.record({ actor, action: "equipnet.switch.backup", target: { type: "switch", name }, detail: { file: name, sizeBytes: stat.size } })
  return new Response(fileStream(file), {
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(stat.size),
      "content-disposition": attachmentDisposition(name),
      "cache-control": "no-store",
    },
  })
})
