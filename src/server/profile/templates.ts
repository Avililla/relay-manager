// Reads and validates <perfil>/plantillas/*.json (only top-level *.json; names starting with "." or "_" are skipped).
import fs from "node:fs"
import path from "node:path"
import { parseTemplateFile, type TemplateFile } from "@/lib/contracts/template-file"
import { PROFILE_TEMPLATES_DIR } from "./keys"

export interface ProfileTemplate extends TemplateFile {
  /** Relative to the profile dir: "plantillas/equipo-a.json". */
  file: string
  /** Position used in the lists: the file's "position" or its order among the files. */
  order: number
}
export interface ProfileTemplateError {
  file: string
  /** The key read from the file even if it is invalid (its template is then left as it is); null if unreadable. */
  key: string | null
  /** "plantillas/x.json: consoles[0].key: …" */
  messages: string[]
}
export interface ProfileTemplates {
  /** null: no profile directory. */
  dir: string | null
  /** The plantillas/ folder exists. */
  found: boolean
  templates: ProfileTemplate[]
  errors: ProfileTemplateError[]
}

export interface TemplatesFs {
  readdir(dir: string): string[] | null
  readText(file: string): string
  isFile(file: string): boolean
}
export const nodeTemplatesFs: TemplatesFs = {
  readdir(dir) {
    try { return fs.readdirSync(dir) } catch { return null }
  },
  readText: (f) => fs.readFileSync(f, "utf8"),
  isFile(f) {
    try { return fs.statSync(f).isFile() } catch { return false }
  },
}

const MAX_FILE_BYTES = 256 * 1024

export function loadProfileTemplates(dir: string | null, fsx: TemplatesFs = nodeTemplatesFs): ProfileTemplates {
  if (!dir) return { dir: null, found: false, templates: [], errors: [] }
  const tdir = path.join(dir, PROFILE_TEMPLATES_DIR)
  const names = fsx.readdir(tdir)
  if (names === null) return { dir, found: false, templates: [], errors: [] }
  const files = names.filter((n) => n.endsWith(".json") && !n.startsWith(".") && !n.startsWith("_")).sort()
  const out: ProfileTemplates = { dir, found: true, templates: [], errors: [] }
  const seen = new Map<string, string>()
  files.forEach((name, i) => {
    const rel = `${PROFILE_TEMPLATES_DIR}/${name}`
    const full = path.join(tdir, name)
    if (!fsx.isFile(full)) return
    let text: string
    try {
      text = fsx.readText(full)
    } catch (err) {
      out.errors.push({ file: rel, key: null, messages: [`${rel}: no se puede leer (${err instanceof Error ? err.message : String(err)})`] })
      return
    }
    if (Buffer.byteLength(text) > MAX_FILE_BYTES) {
      out.errors.push({ file: rel, key: null, messages: [`${rel}: el fichero es demasiado grande (como mucho 256 KiB)`] })
      return
    }
    const r = parseTemplateFile(text)
    if (!r.ok) {
      out.errors.push({ file: rel, key: r.key, messages: r.errors.map((e) => `${rel}: ${e}`) })
      return
    }
    const other = seen.get(r.template.key)
    if (other) {
      out.errors.push({ file: rel, key: null, messages: [`${rel}: key: la clave «${r.template.key}» ya la usa ${other}`] })
      return
    }
    seen.set(r.template.key, rel)
    out.templates.push({ ...r.template, file: rel, order: r.template.position ?? i })
  })
  return out
}

/** Every error message, one per line. */
export function templateErrorLines(t: ProfileTemplates): string[] {
  return t.errors.flatMap((e) => e.messages)
}
