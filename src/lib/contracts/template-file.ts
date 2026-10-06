// Equipment templates defined in files of the profile («perfil»): <perfil>/plantillas/*.json, one template per file.
// The files are the source of truth (the app copies them into the database on start, «Recargar plantillas» and
// `relay-manager plantillas recargar`). The JSON Schema in docs/plantilla.schema.json is generated from
// TemplateFileJsonSchema (a test keeps it in sync).
import { z } from "zod"
import { TemplateSpecSchema, type TemplateSpec } from "./templates"

/** Stable identity of a template file ("equipo-a"): never change it once equipment were created from it. */
export const TEMPLATE_FILE_KEY_RE = /^[a-z0-9][a-z0-9-]{0,39}$/

const specShape = TemplateSpecSchema.shape
const metaShape = {
  /** Editors' schema hint; ignored. */
  $schema: z.string().optional(),
  key: z.string().regex(TEMPLATE_FILE_KEY_RE, "Usa minúsculas, números y guiones, empezando por letra o número (p. ej. equipo-a), como mucho 40"),
  name: z.string().trim().min(1, "Obligatorio").max(40, "Como mucho 40 caracteres"),
  description: z.string().trim().max(300, "Como mucho 300 caracteres").nullable().default(null),
  /** Shows the «Revisar» chip (placeholder values that someone must check). */
  needsReview: z.boolean().default(false),
  /** Order in the lists (lower first); by default the order of the file names. */
  position: z.number().int().min(0).max(9999).optional(),
}

/** The whole file: the template's identity plus its spec (without "version", which is always 1). Unknown keys are errors. */
export const TemplateFileJsonSchema = z.strictObject({
  ...metaShape,
  namePattern: specShape.namePattern,
  skipInterfaces: specShape.skipInterfaces,
  consoles: specShape.consoles,
  relays: specShape.relays.default([]),
  accesses: specShape.accesses,
})

export interface TemplateFile {
  key: string
  name: string
  description: string | null
  needsReview: boolean
  position: number | null
  spec: TemplateSpec
}

export type TemplateFileParse = { ok: true; template: TemplateFile } | { ok: false; key: string | null; errors: string[] }

/** `consoles[1].key` */
export function formatIssuePath(path: readonly PropertyKey[]): string {
  let out = ""
  for (const p of path) {
    if (typeof p === "number") out += `[${p}]`
    else out += out ? `.${String(p)}` : String(p)
  }
  return out
}

const esLocale = z.locales.es()
function issues(err: z.ZodError): string[] {
  return err.issues.map((i) => (i.path.length ? `${formatIssuePath(i.path)}: ${i.message}` : i.message))
}

/** Line and column of a JSON.parse error ("… at position 42 (line 3 column 5)" or only the position). */
export function jsonErrorMessage(text: string, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  const lc = /line (\d+) column (\d+)/.exec(msg)
  if (lc) return `JSON no válido (línea ${lc[1]}, columna ${lc[2]})`
  const pos = /position (\d+)/.exec(msg)
  if (pos) {
    const before = text.slice(0, Number(pos[1]))
    const line = before.split("\n").length
    const column = before.length - before.lastIndexOf("\n")
    return `JSON no válido (línea ${line}, columna ${column})`
  }
  return "JSON no válido"
}

/** Validates the text of one template file. Errors are Spanish, each prefixed with the JSON path. */
export function parseTemplateFile(text: string): TemplateFileParse {
  let raw: unknown
  try {
    raw = JSON.parse(text.replace(/^﻿/, ""))
  } catch (err) {
    return { ok: false, key: null, errors: [jsonErrorMessage(text, err)] }
  }
  const rawKey = typeof raw === "object" && raw !== null && !Array.isArray(raw) && typeof (raw as { key?: unknown }).key === "string"
    && TEMPLATE_FILE_KEY_RE.test((raw as { key: string }).key) ? (raw as { key: string }).key : null
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, key: null, errors: ["Debe ser un objeto JSON ({ … })"] }
  const meta = TemplateFileJsonSchema.safeParse(raw, { error: esLocale.localeError })
  if (!meta.success) return { ok: false, key: rawKey, errors: issues(meta.error) }
  const f = meta.data
  // Cross-field checks (repeated keys, serial accesses pointing at a console of the template…).
  const spec = TemplateSpecSchema.safeParse({
    version: 1, namePattern: f.namePattern, skipInterfaces: f.skipInterfaces, consoles: f.consoles, relays: f.relays, accesses: f.accesses,
  }, { error: esLocale.localeError })
  if (!spec.success) return { ok: false, key: f.key, errors: issues(spec.error) }
  return {
    ok: true,
    template: { key: f.key, name: f.name, description: f.description || null, needsReview: f.needsReview, position: f.position ?? null, spec: spec.data },
  }
}
