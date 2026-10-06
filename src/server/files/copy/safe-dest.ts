// «Copiar a una carpeta del servidor»: writing into a destination folder without following links. Shared by the service
// (as itself) and the root helper (as root): the same code decides how a folder is opened, how the temporary file is
// written, verified and committed, so the two paths behave the same.
//
// The destination is given as a REAL path (realpath done by the caller, then the deny-list checked on it). It is opened
// component by component from "/" with O_DIRECTORY | O_NOFOLLOW through the descriptor of the previous component
// (/proc/self/fd/<n>/<name>, like openat()): a component swapped for a link after the realpath fails instead of being
// followed, and /proc/self/fd/<n> of the result must still be that real path. Everything afterwards (temporary file,
// rename, new folder, listing) goes through the descriptor of the open folder, never through the path again.
import crypto from "node:crypto"
import fs from "node:fs"
import type { CopyConflict } from "@/lib/contracts/files"
import { COPY_TEMP_PREFIX } from "@/lib/files/temp-names"
import { keepBothName, validateNewName } from "@/lib/files/names"
import type { HelperErrorCode } from "./protocol"

const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0
const O_DIRECTORY = fs.constants.O_DIRECTORY ?? 0
/** link() not supported (vfat, exfat, ntfs3 without hard links, some FUSE): check-then-rename instead. */
const NO_LINKS = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "EXDEV", "EMLINK", "ENOSYS"])
const NO_SPACE = new Set(["ENOSPC", "EDQUOT"])
const errno = (e: unknown) => (e as NodeJS.ErrnoException | null)?.code ?? ""

/** A copy failure with a Spanish message (codes shared with the helper protocol). */
export class CopyError extends Error {
  constructor(readonly code: HelperErrorCode, message: string) {
    super(message)
  }
}

/** Maps an errno of an operation in the destination to a CopyError. */
export function fsCopyError(e: unknown, what: string): CopyError {
  if (e instanceof CopyError) return e
  const c = errno(e)
  if (NO_SPACE.has(c)) return new CopyError("NO_SPACE", `No queda espacio en el destino (${what}).`)
  if (c === "EROFS") return new CopyError("READ_ONLY", "El destino es de solo lectura.")
  if (c === "EACCES" || c === "EPERM") return new CopyError("ACCESS", `Sin permiso para escribir en la carpeta de destino (${what}).`)
  if (c === "ENOENT") return new CopyError("NOT_FOUND", "La carpeta de destino ya no existe (¿se ha quitado el disco?).")
  if (c === "ELOOP" || c === "ENOTDIR") return new CopyError("DENIED", "La carpeta de destino ha cambiado (un enlace simbólico): vuelve a elegirla.")
  if (c === "EINVAL" || c === "ENAMETOOLONG" || c === "EILSEQ") return new CopyError("INVALID", "Ese nombre no es válido en el disco de destino (FAT y exFAT no admiten : ? * < > | \" ni \\).")
  if (c === "EIO") return new CopyError("IO", "Error de lectura o escritura en el disco de destino (¿se ha quitado?).")
  return new CopyError("IO", `Error al escribir en el destino (${what}: ${c || (e instanceof Error ? e.message : String(e))}).`)
}

export interface DestDir {
  /** "/proc/self/fd/<n>": entries are built on it. */
  at: string
  real: string
  uid: number
  gid: number
  close(): Promise<void>
}

/** "/a/b" → ["a", "b"]; "/" → []. The path must be normalised (policy.normalizeAbs). */
function segmentsOf(real: string): string[] {
  return real.split("/").filter((s) => s !== "")
}

/**
 * Opens a folder given by its real path, component by component, never following a link. Throws CopyError
 * (NOT_FOUND, DENIED when a component is a link or not a folder, ACCESS).
 */
export async function openDestDir(real: string): Promise<DestDir> {
  const segs = segmentsOf(real)
  if (segs.some((s) => s === "." || s === "..")) throw new CopyError("INVALID", "Ruta no válida.")
  let h: fs.promises.FileHandle
  try {
    h = await fs.promises.open("/", fs.constants.O_RDONLY | O_DIRECTORY)
  } catch (e) {
    throw fsCopyError(e, "/")
  }
  try {
    for (const s of segs) {
      const next = await fs.promises.open(`/proc/self/fd/${h.fd}/${s}`, fs.constants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
      await h.close().catch(() => undefined)
      h = next
    }
    const where = await fs.promises.readlink(`/proc/self/fd/${h.fd}`)
    if (where !== (segs.length ? `/${segs.join("/")}` : "/")) throw new CopyError("DENIED", "La carpeta de destino ha cambiado mientras se abría: vuelve a elegirla.")
    const st = await h.stat()
    if (!st.isDirectory()) throw new CopyError("DENIED", "El destino no es una carpeta.")
    const handle = h
    return { at: `/proc/self/fd/${handle.fd}`, real: where, uid: st.uid, gid: st.gid, close: () => handle.close().catch(() => undefined) }
  } catch (e) {
    await h.close().catch(() => undefined)
    throw fsCopyError(e, "abrir la carpeta")
  }
}

/** Why a name cannot be created in a destination (Spanish), or null. */
export function copyNameProblem(name: string): string | null {
  const why = validateNewName(name)
  if (why) return why
  if (name.startsWith(COPY_TEMP_PREFIX)) return "Ese nombre está reservado para las copias en curso: usa otro nombre."
  return null
}

async function lstatOrNull(p: string): Promise<fs.Stats | null> {
  try {
    return await fs.promises.lstat(p)
  } catch (e) {
    if (errno(e) === "ENOENT") return null
    throw e
  }
}

/** Free space of the destination's filesystem (null when unknown). */
export async function spaceOf(dir: DestDir): Promise<{ freeBytes: number; totalBytes: number } | null> {
  try {
    const s = await fs.promises.statfs(dir.at)
    return { freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize }
  } catch {
    return null
  }
}

/** Can the current process write in the folder (permissions, read-only mount)? */
export async function canWrite(dir: DestDir): Promise<boolean> {
  try {
    await fs.promises.access(dir.at, fs.constants.W_OK | fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * The plan for a name before transferring anything: "skip" when it exists and the policy is to skip; an existing
 * folder with that name cannot be replaced.
 */
export async function precheck(dir: DestDir, name: string, conflict: CopyConflict): Promise<"go" | "skip"> {
  const why = copyNameProblem(name)
  if (why) throw new CopyError("INVALID", why)
  const st = await lstatOrNull(`${dir.at}/${name}`).catch((e: unknown) => { throw fsCopyError(e, "comprobar el nombre") })
  if (!st) return "go"
  if (conflict === "skip") return "skip"
  if (conflict === "replace" && st.isDirectory()) throw new CopyError("EXISTS", `Ya hay una carpeta «${name}» en el destino: no se reemplaza una carpeta por un archivo.`)
  return "go"
}

export interface WriteOptions {
  size: number
  source: AsyncIterable<Buffer>
  /** Final mode of the file (0644). */
  mode: number
  /** Root helper: the owner of the destination folder gets the file (null: keep the writer's). */
  owner: { uid: number; gid: number } | null
  signal?: AbortSignal
  onProgress?(bytes: number): void
  onVerifying?(): void
}
export interface WriteResult { name: string | null; skipped: boolean; replaced: boolean; sha256: string | null }

const MARGIN = 1024 * 1024

/**
 * Writes `size` bytes from `source` into a temporary file of the folder (0600, O_EXCL), fsyncs it, reads it back to
 * compare its sha256 with what was received, sets the mode (and the owner) and commits it under `name` following the
 * conflict policy: "replace" renames over the old file (atomic; never a folder), "keep" takes the first free
 * "name (n).ext" without overwriting anything, "skip" leaves an existing name alone. The temporary file is removed on
 * any failure or cancellation.
 */
export async function writeIntoDir(dir: DestDir, name: string, conflict: CopyConflict, o: WriteOptions): Promise<WriteResult> {
  if ((await precheck(dir, name, conflict)) === "skip") return { name: null, skipped: true, replaced: false, sha256: null }
  const space = await spaceOf(dir)
  if (space && space.freeBytes < o.size + MARGIN) {
    throw new CopyError("NO_SPACE", `No hay espacio en el destino: hacen falta ${o.size} bytes y quedan ${space.freeBytes}.`)
  }
  const tmpName = `${COPY_TEMP_PREFIX}${crypto.randomBytes(8).toString("hex")}.part`
  const tmp = `${dir.at}/${tmpName}`
  let h: fs.promises.FileHandle
  try {
    h = await fs.promises.open(tmp, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW, 0o600)
  } catch (e) {
    throw fsCopyError(e, "crear el archivo temporal")
  }
  let open = true
  const closeH = async () => {
    if (open) {
      open = false
      await h.close().catch(() => undefined)
    }
  }
  try {
    const hash = crypto.createHash("sha256")
    let written = 0
    for await (const chunk of o.source) {
      if (o.signal?.aborted) throw new CopyError("CANCELED", "Copia cancelada.")
      if (written + chunk.length > o.size) throw new CopyError("IO", "El archivo de origen ha crecido mientras se copiaba.")
      let off = 0
      while (off < chunk.length) {
        const { bytesWritten } = await h.write(chunk, off, chunk.length - off, written + off).catch((e: unknown) => { throw fsCopyError(e, "escribir") })
        off += bytesWritten
      }
      hash.update(chunk)
      written += chunk.length
      o.onProgress?.(written)
    }
    if (o.signal?.aborted) throw new CopyError("CANCELED", "Copia cancelada.")
    if (written !== o.size) throw new CopyError("CANCELED", "La copia se ha interrumpido antes de terminar.")
    await h.sync().catch((e: unknown) => { throw fsCopyError(e, "fsync") })
    const sha256 = hash.digest("hex")
    o.onVerifying?.()
    // Read back what is in the file (page cache after fsync: catches short or misplaced writes, not a bad medium).
    const check = crypto.createHash("sha256")
    const buf = Buffer.allocUnsafe(1024 * 1024)
    let pos = 0
    while (pos < o.size) {
      if (o.signal?.aborted) throw new CopyError("CANCELED", "Copia cancelada.")
      const { bytesRead } = await h.read(buf, 0, Math.min(buf.length, o.size - pos), pos).catch((e: unknown) => { throw fsCopyError(e, "verificar") })
      if (bytesRead === 0) break
      check.update(buf.subarray(0, bytesRead))
      pos += bytesRead
    }
    if (pos !== o.size || check.digest("hex") !== sha256) throw new CopyError("VERIFY", "La copia no coincide con el original (sha256): no se ha guardado.")
    // Mode first (fchmod needs to own the file, or CAP_FOWNER), then the owner. vfat/exfat/ntfs refuse both: ignored.
    await h.chmod(o.mode).catch((e: unknown) => { if (!["EPERM", "ENOTSUP", "EOPNOTSUPP", "EROFS"].includes(errno(e))) throw fsCopyError(e, "permisos") })
    if (o.owner) {
      await h.chown(o.owner.uid, o.owner.gid).catch((e: unknown) => { if (!["EPERM", "EINVAL", "ENOTSUP", "EOPNOTSUPP"].includes(errno(e))) throw fsCopyError(e, "propietario") })
    }
    await closeH()
    if (o.signal?.aborted) throw new CopyError("CANCELED", "Copia cancelada.")
    const placed = await commit(dir, tmpName, name, conflict)
    return { ...placed, sha256: placed.skipped ? null : sha256 }
  } catch (e) {
    await closeH()
    await fs.promises.unlink(tmp).catch(() => undefined)
    throw fsCopyError(e, "copiar")
  }
}

/** The temporary file → its final name, following the conflict policy (see writeIntoDir). */
async function commit(dir: DestDir, tmpName: string, name: string, conflict: CopyConflict): Promise<{ name: string | null; skipped: boolean; replaced: boolean }> {
  const tmp = `${dir.at}/${tmpName}`
  if (conflict === "replace") {
    const st = await lstatOrNull(`${dir.at}/${name}`)
    if (st?.isDirectory()) throw new CopyError("EXISTS", `Ya hay una carpeta «${name}» en el destino: no se reemplaza una carpeta por un archivo.`)
    await fs.promises.rename(tmp, `${dir.at}/${name}`)
    return { name, skipped: false, replaced: !!st }
  }
  const maxN = conflict === "skip" ? 0 : 10_000
  for (let n = 0; n <= maxN; n++) {
    const candidate = n === 0 ? name : keepBothName(name, n)
    try {
      await placeNoClobber(tmp, `${dir.at}/${candidate}`)
      return { name: candidate, skipped: false, replaced: false }
    } catch (e) {
      if (errno(e) !== "EEXIST") throw e
    }
  }
  if (conflict === "skip") {
    await fs.promises.unlink(tmp).catch(() => undefined)
    return { name: null, skipped: true, replaced: false }
  }
  throw new CopyError("EXISTS", `Ya existe «${name}» en el destino.`)
}

/** tmp → dest only if dest does not exist: hard link + unlink (atomic), or check + rename without hard links. */
async function placeNoClobber(tmp: string, dest: string): Promise<void> {
  try {
    await fs.promises.link(tmp, dest)
  } catch (e) {
    if (!NO_LINKS.has(errno(e))) throw e
    if (await lstatOrNull(dest)) throw Object.assign(new Error("exists"), { code: "EEXIST" })
    await fs.promises.rename(tmp, dest)
    return
  }
  await fs.promises.unlink(tmp).catch(() => undefined)
}

/** A new folder in `dir` (0755; the owner of `dir` when `owner` is given). Returns its real path. */
export async function mkdirIn(dir: DestDir, name: string, owner: { uid: number; gid: number } | null): Promise<string> {
  const why = copyNameProblem(name)
  if (why) throw new CopyError("INVALID", why)
  try {
    await fs.promises.mkdir(`${dir.at}/${name}`, 0o755)
  } catch (e) {
    if (errno(e) === "EEXIST") throw new CopyError("EXISTS", `Ya existe «${name}» en esa carpeta.`)
    throw fsCopyError(e, "crear la carpeta")
  }
  let h: fs.promises.FileHandle | null = null
  try {
    h = await fs.promises.open(`${dir.at}/${name}`, fs.constants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
    await h.chmod(0o755).catch(() => undefined)
    if (owner) await h.chown(owner.uid, owner.gid).catch((e: unknown) => { if (!["EPERM", "EINVAL", "ENOTSUP", "EOPNOTSUPP"].includes(errno(e))) throw e })
  } catch (e) {
    throw fsCopyError(e, "crear la carpeta")
  } finally {
    await h?.close().catch(() => undefined)
  }
  return dir.real === "/" ? `/${name}` : `${dir.real}/${name}`
}

export interface FolderEntry { name: string; hidden: boolean; link: boolean }

/** The subfolders of an open folder (links to folders included and marked), sorted, at most `limit`. */
export async function listFolders(dir: DestDir, hidden: boolean, limit = 2000): Promise<{ folders: FolderEntry[]; truncated: boolean }> {
  const out: FolderEntry[] = []
  let truncated = false
  let d: fs.Dir
  try {
    d = await fs.promises.opendir(dir.at)
  } catch (e) {
    throw fsCopyError(e, "leer la carpeta")
  }
  try {
    for await (const e of d) {
      const isHidden = e.name.startsWith(".")
      if (isHidden && !hidden) continue
      let isDir = e.isDirectory()
      const link = e.isSymbolicLink()
      if (link) isDir = await fs.promises.stat(`${dir.at}/${e.name}`).then((s) => s.isDirectory(), () => false)
      if (!isDir) continue
      if (out.length >= limit) {
        truncated = true
        break
      }
      out.push({ name: e.name, hidden: isHidden, link })
    }
  } finally {
    await d.close().catch(() => undefined)
  }
  out.sort((a, b) => a.name.localeCompare(b.name, "es", { numeric: true }))
  return { folders: out, truncated }
}

export interface ListedEntry { name: string; kind: "dir" | "file" | "other"; hidden: boolean; link: boolean; size: number | null; mtimeMs: number | null }

/**
 * Folders and files of an open folder, metadata only (lstat; a link is marked and described by its target's type):
 * nothing is ever opened for reading. Folders first, then files, each sorted; at most `limit` in total.
 */
export async function listEntries(dir: DestDir, hidden: boolean, limit = 2000): Promise<{ entries: ListedEntry[]; truncated: boolean }> {
  const names: string[] = []
  let truncated = false
  let d: fs.Dir
  try {
    d = await fs.promises.opendir(dir.at)
  } catch (e) {
    throw fsCopyError(e, "leer la carpeta")
  }
  try {
    for await (const e of d) {
      if (e.name.startsWith(".") && !hidden) continue
      if (names.length >= limit) {
        truncated = true
        break
      }
      names.push(e.name)
    }
  } finally {
    await d.close().catch(() => undefined)
  }
  const out: ListedEntry[] = []
  for (const name of names) {
    const p = `${dir.at}/${name}`
    const l = await fs.promises.lstat(p).catch(() => null)
    if (!l) continue
    const link = l.isSymbolicLink()
    const st = link ? await fs.promises.stat(p).catch(() => null) : l
    const kind = st?.isDirectory() ? "dir" : st?.isFile() ? "file" : "other"
    // A link: only whether it leads to a folder (to browse it); never the size or date of what it points to (as root,
    // that could be anything on the system).
    out.push({ name, kind, hidden: name.startsWith("."), link, size: kind === "file" && st && !link ? st.size : null, mtimeMs: l.mtimeMs })
  }
  const rank = (k: ListedEntry["kind"]) => (k === "dir" ? 0 : k === "file" ? 1 : 2)
  out.sort((a, b) => rank(a.kind) - rank(b.kind) || a.name.localeCompare(b.name, "es", { numeric: true }))
  return { entries: out, truncated }
}
