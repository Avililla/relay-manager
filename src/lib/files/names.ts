// Pure helpers for "Archivos" paths and names (server and browser). The server re-checks everything on disk
// (src/server/files/paths.ts); these rules only decide what a relative path or a new name may look like.
import { UPLOAD_TEMP_PREFIX } from "./temp-names"

export const NAME_MAX_BYTES = 255
const PATH_MAX_CHARS = 4096
const CONTROL = /[\u0000-\u001f\u007f]/

const bytes = (s: string) => new TextEncoder().encode(s).length

export type ParsedRelPath = { ok: true; segments: string[]; path: string } | { ok: false }

/**
 * A client-supplied relative path: "" (the folder itself) or segments joined by "/". Never absolute, never "." or
 * "..", no empty segment (so no leading, trailing or double slash), no NUL, segments of at most 255 bytes.
 * Percent sequences are NOT decoded here: the HTTP layer decodes the query string exactly once.
 */
export function parseRelPath(raw: unknown): ParsedRelPath {
  if (typeof raw !== "string" || raw.length > PATH_MAX_CHARS || raw.includes("\0")) return { ok: false }
  if (raw === "") return { ok: true, segments: [], path: "" }
  const segments = raw.split("/")
  for (const s of segments) {
    if (s === "" || s === "." || s === ".." || bytes(s) > NAME_MAX_BYTES) return { ok: false }
  }
  return { ok: true, segments, path: segments.join("/") }
}

/** Why a new name (upload, new folder, rename) is not acceptable, in Spanish; null when it is fine. */
export function validateNewName(name: string): string | null {
  if (name === "") return "Escribe un nombre."
  if (name === "." || name === "..") return "El nombre no puede ser «.» ni «..»."
  if (name.includes("/") || name.includes("\\")) return "El nombre no puede contener «/» ni «\\»."
  if (CONTROL.test(name)) return "El nombre no puede contener caracteres de control."
  if (name.trim() !== name) return "El nombre no puede empezar ni terminar con espacios."
  if (bytes(name) > NAME_MAX_BYTES) return `El nombre es demasiado largo (máximo ${NAME_MAX_BYTES} bytes).`
  if (name.startsWith(UPLOAD_TEMP_PREFIX)) return "Ese nombre está reservado para las subidas en curso: usa otro nombre."
  return null
}

const COMPOUND = /\.(tar\.(gz|bz2|xz|zst|lz4)|img\.(gz|xz|bz2))$/i

function splitExt(name: string): { stem: string; ext: string } {
  const compound = COMPOUND.exec(name)
  if (compound && compound.index > 0) return { stem: name.slice(0, compound.index), ext: name.slice(compound.index) }
  const dot = name.lastIndexOf(".")
  if (dot <= 0) return { stem: name, ext: "" }
  return { stem: name.slice(0, dot), ext: name.slice(dot) }
}

/** "informe.pdf", 2 → "informe (2).pdf"; an existing " (n)" suffix is replaced; the result fits in 255 bytes. */
export function keepBothName(name: string, n: number): string {
  const { stem: rawStem, ext } = splitExt(name)
  const stem = rawStem.replace(/ \(\d+\)$/, "") || rawStem
  const suffix = ` (${n})${ext}`
  let s = stem
  while (s.length > 0 && bytes(s + suffix) > NAME_MAX_BYTES) s = Array.from(s).slice(0, -1).join("")
  return (s || "archivo") + suffix
}

/** The name itself when free, else the first free "name (n).ext". */
export function nextFreeName(name: string, taken: (candidate: string) => boolean, max = 10_000): string {
  if (!taken(name)) return name
  for (let i = 1; i <= max; i++) {
    const c = keepBothName(name, i)
    if (!taken(c)) return c
  }
  return keepBothName(name, Date.now())
}

export function joinRel(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name
}

export function parentRel(rel: string): string {
  const i = rel.lastIndexOf("/")
  return i < 0 ? "" : rel.slice(0, i)
}

export function baseName(rel: string): string {
  const i = rel.lastIndexOf("/")
  return i < 0 ? rel : rel.slice(i + 1)
}
