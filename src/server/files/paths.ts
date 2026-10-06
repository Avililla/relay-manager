// Path safety for "Archivos" (Graph A). Every client path is relative to RM_FILES_DIR and is resolved against the
// REAL path of the folder: `..`, absolute paths and NUL are refused by the parser, and symbolic links are followed
// only while they stay inside the folder (realpath check).
//
// A check followed by an operation on the same path string would race with anyone who can write in the folder (a
// subfolder swapped for a link to the data dir between the two). So every operation is anchored to a DESCRIPTOR of
// the folder it acts in: the folder is opened (O_DIRECTORY | O_NOFOLLOW), the descriptor is checked through
// /proc/self/fd to be inside, and the operation then uses "/proc/self/fd/<n>/<name>", which the kernel resolves
// through the open descriptor (like the *at() system calls Node does not expose), not through the path again.
import fs from "node:fs"
import path from "node:path"
import type { FilesErrorKind } from "@/lib/contracts/files"
import type { ErrorCode, JsonValue } from "@/lib/contracts/common"
import { parseRelPath } from "@/lib/files/names"
import { DomainError } from "@/server/errors"

const CODE: Record<FilesErrorKind, ErrorCode> = {
  UNAUTHENTICATED: "UNAUTHENTICATED", PASSWORD_CHANGE_REQUIRED: "PASSWORD_CHANGE_REQUIRED", FORBIDDEN: "FORBIDDEN",
  DISABLED: "DISABLED_BY_POLICY", NOT_FOUND: "NOT_FOUND", INVALID: "VALIDATION", EXISTS: "CONFLICT", OFFSET: "CONFLICT",
  BUSY: "CONFLICT", TOO_LARGE: "VALIDATION", NO_SPACE: "SERVICE_UNAVAILABLE", UNAVAILABLE: "SERVICE_UNAVAILABLE",
  RANGE: "VALIDATION", INTERNAL: "INTERNAL",
}

/** A DomainError whose `details.files` is the files error kind (the HTTP layer maps it to a status). */
export function filesError(kind: FilesErrorKind, message: string, extra: Record<string, JsonValue> = {}): DomainError {
  return new DomainError(CODE[kind], message, undefined, { files: kind, ...extra })
}

export function filesErrorKind(e: unknown): FilesErrorKind | null {
  if (typeof e !== "object" || e === null) return null
  const d = (e as { details?: { files?: unknown } }).details
  return typeof d?.files === "string" ? (d.files as FilesErrorKind) : null
}

export const NOT_FOUND_MESSAGE = "No existe: puede que otra persona lo haya movido o borrado. Actualiza la lista."

const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0
const O_DIRECTORY = fs.constants.O_DIRECTORY ?? 0
let procFd: boolean | null = null
/** /proc/self/fd is there (Linux): descriptors can anchor paths. Checked once, on first use. */
function hasProcFd(): boolean {
  if (procFd === null) {
    try {
      procFd = fs.statSync("/proc/self/fd").isDirectory()
    } catch {
      procFd = false
    }
  }
  return procFd
}

/** An open folder inside RM_FILES_DIR: `at` is the anchored path to build entry paths on, `real` its real path. */
export interface OpenDir { at: string; real: string; close(): Promise<void> }

/** "<dir>/<name>" through the descriptor of the folder. */
export const entryAt = (dir: OpenDir, name: string) => `${dir.at}/${name}`

/**
 * Opens a folder without following a final link and checks that the descriptor is inside the folder of Archivos.
 * `p` may itself be anchored ("/proc/self/fd/<n>/<name>"). Not a folder, a link or outside → NOT_FOUND.
 */
export async function openDir(p: string, rootReal: string): Promise<OpenDir> {
  let h: fs.promises.FileHandle
  try {
    h = await fs.promises.open(p, fs.constants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException | null)?.code ?? ""
    if (code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP") throw filesError("NOT_FOUND", NOT_FOUND_MESSAGE)
    throw e
  }
  if (!hasProcFd()) return { at: p, real: p, close: () => h.close().catch(() => undefined) }
  let real: string
  try {
    real = await fs.promises.readlink(`/proc/self/fd/${h.fd}`)
  } catch {
    await h.close().catch(() => undefined)
    throw filesError("NOT_FOUND", NOT_FOUND_MESSAGE)
  }
  if (!isWithin(real, rootReal)) {
    await h.close().catch(() => undefined)
    throw filesError("NOT_FOUND", NOT_FOUND_MESSAGE)
  }
  return { at: `/proc/self/fd/${h.fd}`, real, close: () => h.close().catch(() => undefined) }
}

export function isWithin(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep)
}

export function parseOrThrow(raw: unknown): { segments: string[]; path: string } {
  const p = parseRelPath(raw)
  if (!p.ok) throw filesError("INVALID", "Ruta no válida.")
  return { segments: p.segments, path: p.path }
}

const errno = (e: unknown) => (e as NodeJS.ErrnoException | null)?.code ?? ""

/** The real path of the folder. Missing, not a folder or unreadable → UNAVAILABLE (without the path: users see it). */
export async function openRoot(dir: string): Promise<string> {
  let real: string
  try {
    real = await fs.promises.realpath(dir)
  } catch (e) {
    const why = errno(e) === "ENOENT" ? "no existe" : `no es accesible (${errno(e) || "error"})`
    throw filesError("UNAVAILABLE", `La carpeta de archivos del servidor ${why}. Avisa al administrador.`)
  }
  const st = await fs.promises.stat(real).catch(() => null)
  if (!st?.isDirectory()) throw filesError("UNAVAILABLE", "La carpeta de archivos del servidor no es una carpeta. Avisa al administrador.")
  return real
}

/** An existing entry, links followed; its real path must stay inside the folder. */
export async function resolveExisting(rootReal: string, segments: string[]): Promise<{ real: string; stat: fs.Stats }> {
  const full = path.join(rootReal, ...segments)
  let real: string
  try {
    real = await fs.promises.realpath(full)
  } catch {
    throw filesError("NOT_FOUND", NOT_FOUND_MESSAGE)
  }
  if (!isWithin(real, rootReal)) throw filesError("NOT_FOUND", NOT_FOUND_MESSAGE)
  let stat: fs.Stats
  try {
    stat = await fs.promises.stat(real)
  } catch {
    throw filesError("NOT_FOUND", NOT_FOUND_MESSAGE)
  }
  return { real, stat }
}

/**
 * The real parent folder of an entry (links followed, must stay inside) and the entry path under it. The entry itself
 * is not followed: renaming or deleting a link acts on the link. The folder itself has no parent (INVALID).
 */
export async function resolveParent(rootReal: string, segments: string[]): Promise<{ parentReal: string; name: string; target: string }> {
  if (segments.length === 0) throw filesError("INVALID", "No se puede hacer esto con la carpeta principal.")
  const name = segments[segments.length - 1]
  const parent = await resolveExisting(rootReal, segments.slice(0, -1))
  if (!parent.stat.isDirectory()) throw filesError("NOT_FOUND", NOT_FOUND_MESSAGE)
  return { parentReal: parent.real, name, target: path.join(parent.real, name) }
}

/** Linux: the descriptor must point inside the folder (a link swapped in after the check is caught here). */
export async function assertFdInside(fd: number, rootReal: string): Promise<void> {
  let where: string
  try {
    where = await fs.promises.readlink(`/proc/self/fd/${fd}`)
  } catch {
    return // no /proc (not Linux): the realpath check before opening is all there is
  }
  if (!isWithin(where, rootReal)) throw filesError("NOT_FOUND", NOT_FOUND_MESSAGE)
}
