// «Descargas» (the profile's download script): the dialog's form rules (the server checks again with ExportStartSchema).
import { EXPORT_NAME_RE, EXPORT_WORK_DIR, type ExportStartInput } from "@/lib/contracts/files"
import { parseRelPath, validateNewName } from "./names"
import { exportUi as t } from "@/lib/i18n/files"

export interface ExportForm { app: string; version: string; extract: boolean; zipName: string; dir: string }
export type ExportFormErrors = Partial<Record<"app" | "version" | "zipName" | "dir", string>>

/** "<app>-<version>_exports.zip": what the script names the zip when no name is given. */
export const defaultZipName = (app: string, version: string) => `${app}-${version}_exports.zip`

function nameProblem(v: string): string | null {
  if (!v) return t.required
  if (!EXPORT_NAME_RE.test(v) || v.startsWith("-") || v.startsWith(".")) return t.invalidName
  return null
}

/** The request for POST /api/files/export, or the errors per field. */
export function checkExportForm(f: ExportForm): { ok: true; input: ExportStartInput } | { ok: false; errors: ExportFormErrors } {
  const app = f.app.trim()
  const version = f.version.trim()
  const errors: ExportFormErrors = {}
  const a = nameProblem(app)
  if (a) errors.app = a
  const v = nameProblem(version)
  if (v) errors.version = v
  let zipName: string | null = f.zipName.trim() || null
  if (zipName) {
    if (!/\.zip$/i.test(zipName)) zipName = `${zipName}.zip`
    const why = validateNewName(zipName) ?? (zipName.startsWith(".") ? "El nombre no puede empezar por «.»." : null)
    if (why) errors.zipName = why
  }
  const dirRaw = f.dir.trim().replace(/^\/+|\/+$/g, "")
  const dir = parseRelPath(dirRaw)
  if (!dir.ok || dir.segments[0] === EXPORT_WORK_DIR) errors.dir = t.invalidDir
  if (Object.keys(errors).length || !dir.ok) return { ok: false, errors }
  return { ok: true, input: { app, version, extract: f.extract, zipName, dir: dir.path } }
}
