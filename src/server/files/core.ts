// "Archivos" core (Graph A, rt.files): listing, folders, rename/move/delete, chunked uploads to a temporary file in the
// destination folder with an atomic, no-clobber commit, and download/zip sources. No HTTP here (see http.ts).
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { Transform, type Readable, type Writable } from "node:stream"
import {
  FILES_CHUNK_MAX_BYTES, FILES_LIST_LIMIT, UPLOAD_TEMP_PREFIX,
  type ConflictMode, type DiskSpaceDTO, type FileEntryDTO, type FilesChange, type FilesListingDTO, type FilesSettingsDTO,
  type FilesRootId, type UploadChunkDTO, type UploadStartDTO,
} from "@/lib/contracts/files"
import type { JsonValue } from "@/lib/contracts/common"
import { baseName, joinRel, keepBothName, parentRel, parseRelPath, validateNewName } from "@/lib/files/names"
import { formatBytes } from "@/lib/i18n/format"
import type { AppConfig } from "@/server/config/schema"
import type { Logger } from "@/server/log"
import type { ActorRef, AuditService, EventBus, FilesStatus } from "@/server/runtime/types"
import {
  assertFdInside, entryAt, filesError, filesErrorKind, isWithin, NOT_FOUND_MESSAGE, openDir, openRoot, parseOrThrow, resolveExisting,
  type OpenDir,
} from "./paths"
import type { ArchiveEntry } from "./archive"

export interface ArchiveSkip { path: string; reason: string }
/** Added at the root of an archive when something was left out (links out of the folder, special files…). */
export const SKIPPED_REPORT = "_OMITIDOS.txt"

export const FILE_MODE = 0o664
export const DIR_MODE = 0o775
const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0
const O_NONBLOCK = fs.constants.O_NONBLOCK ?? 0

/** One shared folder of Archivos (a «raíz»). */
export interface FilesRootSpec {
  id: FilesRootId
  /** Absolute folder (configured path; resolved with realpath on every operation). */
  dir: string
  /** Top-level names reserved for the server (the download script's root: ".descargas"): never listed nor touched. */
  reserved: readonly string[]
}

export interface FilesCoreDeps {
  config: Pick<AppConfig, "files" | "dataDir" | "backupDir" | "captureDir" | "dbFile" | "appDir">
  log: Logger
  bus: EventBus
  audit: AuditService
  /** The root this core serves (default: "tftp", RM_FILES_DIR). */
  root?: FilesRootSpec
}
/** Test seams. */
export interface FilesInternals {
  statfs?: (p: string) => Promise<DiskSpaceDTO | null>
  /** Opens the temporary file for one chunk (tests inject a disk that fills up). */
  openWrite?: (file: string, offset: number) => Promise<Writable>
  /** Hard links unsupported (vfat, some FUSE mounts): exercises the check-then-rename fallback. */
  link?: (from: string, to: string) => Promise<void>
  now?: () => number
  sessionIdleMs?: number
  sweepEveryMs?: number
  staleTempMs?: number
  reserveBytes?: number
  maxSessionsPerUser?: number
  maxSessions?: number
}

export interface Uploader { id: string; name: string; username: string; ip: string | null; isAdmin: boolean }

interface Session {
  id: string
  user: Uploader
  dir: string
  name: string
  size: number
  conflict: ConflictMode
  /** The destination folder, held open for the whole upload: the commit happens in it whatever its path becomes. */
  folder: OpenDir
  tmp: string
  received: number
  busy: boolean
  lastActivity: number
}

export interface DownloadSource { handle: fs.promises.FileHandle; size: number; mtime: Date; name: string; path: string; mode: number }

const errno = (e: unknown) => (e as NodeJS.ErrnoException | null)?.code ?? ""
const NO_SPACE = new Set(["ENOSPC", "EDQUOT"])
const NO_LINKS = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV", "EMLINK"])

function noSpaceMessage(free: number | null, size?: number): string {
  const left = free === null ? "" : ` (quedan ${formatBytes(free)}${size !== undefined ? ` y el archivo ocupa ${formatBytes(size)}` : ""})`
  return `No hay espacio en el disco del servidor${left}. Borra archivos que ya no hagan falta o avisa al administrador.`
}

/** A Transform that lets at most `limit` bytes through and counts them. */
class Limiter extends Transform {
  count = 0
  constructor(private readonly limit: number) { super() }
  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null, data?: Buffer) => void): void {
    this.count += chunk.length
    if (this.count > this.limit) {
      cb(filesError("INVALID", "El fragmento es mayor de lo anunciado."))
      return
    }
    cb(null, chunk)
  }
}

/**
 * body → limiter → file. Unlike stream.pipeline, a failing file (ENOSPC) does not destroy the body (the HTTP request):
 * it is unpiped and left for the caller to drain, so the error response still reaches the client.
 */
function writeBody(body: Readable, limiter: Limiter, out: Writable): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    let ended = false
    const finish = (err?: unknown) => {
      if (settled) return
      settled = true
      body.unpipe(limiter)
      limiter.unpipe(out)
      if (err) {
        out.destroy()
        reject(err)
      } else resolve()
    }
    out.on("finish", () => finish())
    out.on("error", (e) => finish(e))
    limiter.on("error", (e) => finish(e))
    body.on("error", (e) => finish(e))
    body.on("end", () => { ended = true })
    body.on("close", () => { if (!ended) finish(Object.assign(new Error("aborted"), { code: "ECONNRESET" })) })
    body.pipe(limiter).pipe(out)
  })
}

export interface FilesCore {
  readonly rootId: FilesRootId
  readonly spec: FilesRootSpec
  settings(): FilesSettingsDTO
  status(): Promise<FilesStatus>
  list(rel: string): Promise<FilesListingDTO>
  mkdir(dir: string, name: string, actor: ActorRef, byName: string): Promise<{ path: string }>
  rename(rel: string, newName: string, actor: ActorRef, byName: string): Promise<{ path: string }>
  move(rels: string[], toDir: string, actor: ActorRef, byName: string): Promise<{ moved: number }>
  remove(rels: string[], actor: ActorRef, byName: string): Promise<{ removed: number }>
  uploadStart(input: { dir: string; name: string; size: number; conflict: ConflictMode }, user: Uploader): Promise<UploadStartDTO>
  uploadChunk(id: string, userId: string, offset: number, body: Readable): Promise<UploadChunkDTO>
  uploadCancel(id: string, userId: string): Promise<void>
  /** An upload session of this root (the chunk and cancel requests only carry its id). */
  hasSession(id: string): boolean
  openDownload(rel: string): Promise<DownloadSource>
  /** The real path of the root folder (checked like every operation). */
  realRoot(): Promise<string>
  /** An existing folder of the root (not reserved): its normalised relative path. NOT_FOUND / INVALID otherwise. */
  checkFolder(rel: string): Promise<string>
  /**
   * Copies a file the server produced (the export downloader's zip, in the service's own data dir: `src` is an open
   * descriptor, never a path) into a folder of the root: a temporary file in that folder (O_EXCL), fsync, 0664, then
   * placed without replacing anything ("name (n).ext"); publishes files.changed.
   */
  importFile(dirRel: string, name: string, src: fs.promises.FileHandle, byName: string): Promise<{ name: string; path: string; size: number }>
  /** Folder or selection download: the entries (walked lazily) and what was left out (filled while walking). */
  archiveSource(dir: string, names: string[]): Promise<{ baseName: string; entries: AsyncGenerator<ArchiveEntry>; skipped: ArchiveSkip[] }>
  sessions(): number
  sweep(): Promise<void>
  start(): Promise<void>
  stop(): Promise<void>
}

export function createFilesCore(deps: FilesCoreDeps, internals: FilesInternals = {}): FilesCore {
  const cfg = deps.config.files
  const spec: FilesRootSpec = deps.root ?? { id: "tftp", dir: cfg.dir, reserved: [] }
  const rootId = spec.id
  const log = deps.log.child(rootId === "tftp" ? "files" : `files.${rootId}`)
  const now = internals.now ?? (() => Date.now())
  const idleMs = internals.sessionIdleMs ?? 15 * 60_000
  const staleTempMs = internals.staleTempMs ?? 3600_000
  const reserve = internals.reserveBytes ?? 256 * 1024 * 1024
  const maxPerUser = internals.maxSessionsPerUser ?? 6
  const maxSessions = internals.maxSessions ?? 64
  const sessions = new Map<string, Session>()
  let timer: ReturnType<typeof setInterval> | null = null

  const statfs = internals.statfs ?? (async (p: string): Promise<DiskSpaceDTO | null> => {
    try {
      const s = await fs.promises.statfs(p)
      return { freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize }
    } catch {
      return null
    }
  })
  const openWrite = internals.openWrite ?? (async (file: string, offset: number): Promise<Writable> => {
    const h = await openInside(file, fs.constants.O_WRONLY, await root())
    return h.createWriteStream({ start: offset, autoClose: true })
  })
  const link = internals.link ?? ((a: string, b: string) => fs.promises.link(a, b))

  /**
   * The real folder; it never contains the data (database, backups, captures) nor the application (the loader checks
   * the configured path lexically; this checks the real paths).
   */
  async function root(): Promise<string> {
    const r = await openRoot(spec.dir)
    const c = deps.config
    for (const d of [c.dataDir, c.backupDir, c.captureDir, path.dirname(c.dbFile), c.appDir]) {
      const real = await fs.promises.realpath(d).catch(() => null)
      if (real && isWithin(real, r)) throw filesError("UNAVAILABLE", "La carpeta de archivos contiene datos del servidor: el administrador debe cambiar RM_FILES_DIR.")
    }
    return r
  }

  /** A path that lands in a reserved top-level folder (directly or through a link): as if it did not exist. */
  function reservedReal(real: string, rootReal: string): boolean {
    return spec.reserved.some((n) => isWithin(real, path.join(rootReal, n)))
  }
  function checkReserved(segments: readonly string[]): void {
    if (segments.length && spec.reserved.includes(segments[0])) throw filesError("NOT_FOUND", NOT_FOUND_MESSAGE)
  }
  /** A new name in folder `dirSegments`: the reserved names are refused at the top. */
  function checkNewNameAt(dirSegments: readonly string[], name: string): void {
    checkName(name)
    if (dirSegments.length === 0 && spec.reserved.includes(name)) throw filesError("INVALID", `«${name}» está reservado para el servidor: usa otro nombre.`)
  }

  /** An existing folder (links followed only inside), opened. */
  async function folder(rootReal: string, segments: string[], notDir: "NOT_FOUND" | "INVALID" = "NOT_FOUND"): Promise<OpenDir> {
    checkReserved(segments)
    const dir = await resolveExisting(rootReal, segments)
    if (reservedReal(dir.real, rootReal)) throw filesError("NOT_FOUND", NOT_FOUND_MESSAGE)
    if (!dir.stat.isDirectory()) {
      throw notDir === "INVALID" ? filesError("INVALID", `«${segments[segments.length - 1] ?? ""}» no es una carpeta.`, { notDir: true }) : filesError("NOT_FOUND", NOT_FOUND_MESSAGE)
    }
    return openDir(dir.real, rootReal)
  }

  function publish(dirs: string[], change: FilesChange, names: string[], byName: string): void {
    deps.bus.publish({ type: "files.changed", root: rootId, dirs: [...new Set(dirs)], change, names: names.slice(0, 50), byName }, { kind: "all" })
  }
  function audit(actor: ActorRef, action: "files.upload" | "files.mkdir" | "files.rename" | "files.move" | "files.delete", target: string,
    detail: Record<string, JsonValue>, outcome: "ok" | "error" = "ok"): void {
    deps.audit.record({ actor, action, outcome, target: { type: "file", id: null, name: target || "/" }, detail: { root: rootId, ...detail } })
  }

  function mapFsError(e: unknown, what: string): never {
    if (filesErrorKind(e)) throw e
    const code = errno(e)
    if (code === "ENOENT") throw filesError("NOT_FOUND", NOT_FOUND_MESSAGE)
    if (code === "EEXIST" || code === "ENOTEMPTY") throw filesError("EXISTS", `Ya existe «${what}» en esa carpeta.`)
    if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
      throw filesError("UNAVAILABLE", `El servidor no tiene permiso para modificar «${what}» (${code}). Avisa al administrador: revisa los permisos de la carpeta de Archivos.`)
    }
    if (NO_SPACE.has(code)) throw filesError("NO_SPACE", noSpaceMessage(null))
    if (code === "EXDEV") throw filesError("INVALID", "No se puede mover entre discos distintos.")
    if (code === "EINVAL") throw filesError("INVALID", "No se puede mover una carpeta dentro de sí misma.")
    throw e
  }

  function checkName(name: string): void {
    const why = validateNewName(name)
    if (why) throw filesError("INVALID", why)
  }

  async function exists(p: string): Promise<fs.Stats | null> {
    return fs.promises.lstat(p).catch(() => null)
  }

  async function entryOf(rootReal: string, dir: OpenDir, name: string): Promise<FileEntryDTO | null> {
    const full = entryAt(dir, name)
    const l = await fs.promises.lstat(full).catch(() => null)
    if (!l) return null
    if (l.isSymbolicLink()) {
      const real = await fs.promises.realpath(full).catch(() => null)
      const st = real && isWithin(real, rootReal) && !reservedReal(real, rootReal) ? await fs.promises.stat(real).catch(() => null) : null
      if (!st || !(st.isFile() || st.isDirectory())) return { name, kind: "other", size: null, mtime: l.mtime.toISOString(), link: true }
      return { name, kind: st.isDirectory() ? "dir" : "file", size: st.isFile() ? st.size : null, mtime: st.mtime.toISOString(), link: true }
    }
    const kind = l.isDirectory() ? "dir" : l.isFile() ? "file" : "other"
    return { name, kind, size: kind === "file" ? l.size : null, mtime: l.mtime.toISOString(), link: false }
  }

  async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
    const out: R[] = new Array<R>(items.length)
    let i = 0
    const worker = async () => {
      while (i < items.length) {
        const k = i++
        out[k] = await fn(items[k])
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
    return out
  }

  /**
   * An entry the user acts on, with its parent folder OPEN (the caller closes `dir`). The entry itself is not
   * followed: renaming or deleting a link acts on the link. `target` is anchored to the folder's descriptor.
   */
  async function existingEntry(rootReal: string, rel: string): Promise<{ dir: OpenDir; name: string; target: string; rel: string; lstat: fs.Stats }> {
    const p = parseOrThrow(rel)
    if (!p.segments.length) throw filesError("INVALID", "No se puede hacer esto con la carpeta principal.")
    checkReserved(p.segments)
    const name = p.segments[p.segments.length - 1]
    const dir = await folder(rootReal, p.segments.slice(0, -1))
    const target = entryAt(dir, name)
    const l = await exists(target)
    if (!l) {
      await dir.close()
      throw filesError("NOT_FOUND", NOT_FOUND_MESSAGE)
    }
    return { dir, name, target, rel: p.path, lstat: l }
  }

  /**
   * Deletes a folder tree through descriptors: every subfolder is opened without following links before it is read,
   * so a subfolder swapped for a link while this runs stops the deletion instead of deleting what the link points to.
   */
  async function rmTree(parentAt: string, name: string, rootReal: string): Promise<void> {
    const p = `${parentAt}/${name}`
    const st = await fs.promises.lstat(p)
    if (!st.isDirectory()) {
      await fs.promises.unlink(p)
      return
    }
    const d = await openDir(p, rootReal)
    try {
      for (const c of await fs.promises.readdir(d.at)) await rmTree(d.at, c, rootReal)
    } finally {
      await d.close()
    }
    await fs.promises.rmdir(p)
  }

  /** `tmp` → `dest` only if `dest` does not exist: hard link + unlink (atomic), or check + rename without hard links. */
  async function placeNoClobber(tmp: string, dest: string): Promise<void> {
    try {
      await link(tmp, dest)
    } catch (e) {
      if (!NO_LINKS.has(errno(e))) throw e
      if (await exists(dest)) throw Object.assign(new Error("exists"), { code: "EEXIST" })
      await fs.promises.rename(tmp, dest)
      return
    }
    await fs.promises.unlink(tmp).catch(() => undefined)
  }

  /**
   * Commits the finished temporary file; returns the final name. "overwrite" replaces a file atomically (rename), never
   * a folder. Otherwise the name is taken only if free, else "name (n).ext": a file created meanwhile by someone else
   * is never replaced ("fail" falls back to keeping both, so nothing uploaded is lost).
   */
  async function commit(s: Session): Promise<string> {
    const target = entryAt(s.folder, s.name)
    if (s.conflict === "overwrite") {
      const l = await exists(target)
      if (!l?.isDirectory()) {
        await fs.promises.rename(s.tmp, target)
        return s.name
      }
    }
    for (let n = 0; n <= 10_000; n++) {
      const name = n === 0 ? s.name : keepBothName(s.name, n)
      try {
        await placeNoClobber(s.tmp, entryAt(s.folder, name))
        return name
      } catch (e) {
        if (errno(e) !== "EEXIST") throw e
      }
    }
    throw filesError("EXISTS", `Ya existe «${s.name}» en esa carpeta.`)
  }

  /** Opens an existing path without following a final link, and checks the descriptor is inside the folder. */
  async function openInside(file: string, flags: number, rootReal: string): Promise<fs.promises.FileHandle> {
    const h = await fs.promises.open(file, flags | O_NOFOLLOW)
    try {
      await assertFdInside(h.fd, rootReal)
      return h
    } catch (e) {
      await h.close().catch(() => undefined)
      throw e
    }
  }

  async function dropSession(s: Session): Promise<void> {
    sessions.delete(s.id)
    await fs.promises.unlink(s.tmp).catch(() => undefined)
    await s.folder.close()
  }

  async function sweepStaleTemps(rootReal: string): Promise<number> {
    let removed = 0
    let budget = 20_000
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > 8 || budget <= 0) return
      let d: fs.Dir
      try { d = await fs.promises.opendir(dir) } catch { return }
      const subdirs: string[] = []
      for await (const e of d) {
        if (--budget <= 0) break
        const full = path.join(dir, e.name)
        if (e.isFile() && e.name.startsWith(UPLOAD_TEMP_PREFIX) && e.name.endsWith(".part")) {
          const id = e.name.slice(UPLOAD_TEMP_PREFIX.length, -".part".length)
          const st = await fs.promises.lstat(full).catch(() => null)
          if (st && !sessions.has(id) && now() - st.mtimeMs > staleTempMs) {
            await fs.promises.unlink(full).then(() => { removed++ }, () => undefined)
          }
        } else if (e.isDirectory() && !(depth === 0 && spec.reserved.includes(e.name))) subdirs.push(full)
      }
      for (const s of subdirs) await walk(s, depth + 1)
    }
    await walk(rootReal, 0)
    return removed
  }

  const core: FilesCore = {
    rootId,
    spec,
    settings: () => ({ maxUploadBytes: cfg.maxUploadBytes, chunkMaxBytes: FILES_CHUNK_MAX_BYTES, deleteAdminOnly: cfg.deleteAdminOnly }),

    async status() {
      const base: FilesStatus = { enabled: cfg.enabled, root: spec.dir, problem: null, writable: false, freeBytes: null, totalBytes: null }
      if (!cfg.enabled) return base
      try {
        const r = await root()
        const writable = await fs.promises.access(r, fs.constants.W_OK | fs.constants.X_OK).then(() => true, () => false)
        const disk = await statfs(r)
        return { ...base, writable, problem: writable ? null : `El servidor no puede escribir en ${spec.dir}`, freeBytes: disk?.freeBytes ?? null, totalBytes: disk?.totalBytes ?? null }
      } catch (e) {
        // For health (administrators): the path goes with the reason.
        return { ...base, problem: `${spec.dir}: ${e instanceof Error ? e.message : String(e)}` }
      }
    },

    async list(rel) {
      const p = parseOrThrow(rel)
      const r = await root()
      const dir = await folder(r, p.segments, "INVALID")
      try {
        const names: string[] = []
        let truncated = false
        const d = await fs.promises.opendir(dir.at).catch((e: unknown) => mapFsError(e, p.path || "/"))
        for await (const e of d) {
          if (e.name.startsWith(UPLOAD_TEMP_PREFIX)) continue
          if (p.segments.length === 0 && spec.reserved.includes(e.name)) continue
          if (names.length >= FILES_LIST_LIMIT) { truncated = true; break }
          names.push(e.name)
        }
        const entries = (await mapLimit(names, 32, (n) => entryOf(r, dir, n))).filter((x): x is FileEntryDTO => x !== null)
        return { root: rootId, path: p.path, entries, truncated, disk: await statfs(dir.at) }
      } finally {
        await dir.close()
      }
    },

    async mkdir(dirRel, name, actor, byName) {
      const p = parseOrThrow(dirRel)
      checkNewNameAt(p.segments, name)
      const r = await root()
      const parent = await folder(r, p.segments)
      try {
        const target = entryAt(parent, name)
        await fs.promises.mkdir(target, { mode: DIR_MODE })
        // The service umask (0027) would leave it 0750: the group (the engineer who owns the folder) must write too.
        // fchmod on a descriptor opened without following links; the setgid bit inherited from the parent is kept.
        const h = await openInside(target, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY, r)
        try {
          const st = await h.stat()
          await h.chmod(DIR_MODE | (st.mode & 0o2000))
        } finally {
          await h.close()
        }
      } catch (e) {
        mapFsError(e, name)
      } finally {
        await parent.close()
      }
      const rel = joinRel(p.path, name)
      audit(actor, "files.mkdir", rel, { path: rel })
      publish([p.path], "mkdir", [name], byName)
      return { path: rel }
    },

    async rename(rel, newName, actor, byName) {
      checkName(newName)
      const r = await root()
      const src = await existingEntry(r, rel)
      if (src.rel === src.name && spec.reserved.includes(newName)) {
        await src.dir.close()
        throw filesError("INVALID", `«${newName}» está reservado para el servidor: usa otro nombre.`)
      }
      try {
        if (src.name === newName) return { path: src.rel }
        const dest = entryAt(src.dir, newName)
        const clash = await exists(dest)
        // Same inode: only the letter case changes on a case-insensitive file system.
        if (clash && !(clash.ino === src.lstat.ino && clash.dev === src.lstat.dev)) throw filesError("EXISTS", `Ya existe «${newName}» en esta carpeta.`)
        await fs.promises.rename(src.target, dest).catch((e: unknown) => mapFsError(e, newName))
      } finally {
        await src.dir.close()
      }
      const dirRel = parentRel(src.rel)
      const to = joinRel(dirRel, newName)
      audit(actor, "files.rename", src.rel, { from: src.rel, to, kind: src.lstat.isDirectory() ? "dir" : "file" })
      publish([dirRel], "rename", [src.name, newName], byName)
      return { path: to }
    },

    async move(rels, toDirRel, actor, byName) {
      const r = await root()
      const to = parseOrThrow(toDirRel)
      const dest = await folder(r, to.segments)
      const opened: OpenDir[] = [dest]
      const items: Array<Awaited<ReturnType<typeof existingEntry>>> = []
      let moved = 0
      const dirs = new Set<string>([to.path])
      try {
        for (const rel of rels) {
          const src = await existingEntry(r, rel)
          opened.push(src.dir)
          if (src.dir.real === dest.real) continue // already there
          if (src.lstat.isDirectory()) {
            const d = await openDir(src.target, r)
            await d.close()
            if (isWithin(dest.real, d.real)) throw filesError("INVALID", `No se puede mover «${src.name}» dentro de sí misma.`)
          }
          if (await exists(entryAt(dest, src.name))) throw filesError("EXISTS", `Ya existe «${src.name}» en la carpeta de destino.`)
          items.push(src)
        }
        for (const src of items) {
          if (await exists(entryAt(dest, src.name))) throw filesError("EXISTS", `Ya existe «${src.name}» en la carpeta de destino.`)
          await fs.promises.rename(src.target, entryAt(dest, src.name)).catch((e: unknown) => mapFsError(e, src.name))
          moved++
          dirs.add(parentRel(src.rel))
        }
      } finally {
        for (const d of opened) await d.close()
        if (moved) {
          audit(actor, "files.move", to.path, { from: items.slice(0, moved).map((s) => s.rel), to: to.path || "/", count: moved })
          publish([...dirs], "move", items.slice(0, moved).map((s) => s.name), byName)
        }
      }
      return { moved }
    },

    async remove(rels, actor, byName) {
      const r = await root()
      const items: Array<Awaited<ReturnType<typeof existingEntry>>> = []
      let removed = 0
      const dirs = new Set<string>()
      const done: Array<{ path: string; kind: string; sizeBytes: number | null }> = []
      try {
        for (const rel of rels) items.push(await existingEntry(r, rel))
        for (const it of items) {
          const isDir = it.lstat.isDirectory()
          // Links are removed as links; folders through descriptors (rmTree), never through a path read again.
          if (isDir) await rmTree(it.dir.at, it.name, r).catch((e: unknown) => mapFsError(e, it.name))
          else await fs.promises.unlink(it.target).catch((e: unknown) => mapFsError(e, it.name))
          removed++
          dirs.add(parentRel(it.rel))
          done.push({ path: it.rel, kind: isDir ? "dir" : it.lstat.isSymbolicLink() ? "link" : "file", sizeBytes: isDir ? null : it.lstat.size })
        }
      } finally {
        for (const it of items) await it.dir.close()
        if (removed) {
          audit(actor, "files.delete", done.length === 1 ? done[0].path : parentRel(done[0].path), { items: done.slice(0, 100), count: removed })
          publish([...dirs], "delete", done.map((d) => baseName(d.path)), byName)
        }
      }
      return { removed }
    },

    async uploadStart(input, user) {
      checkNewNameAt(parseOrThrow(input.dir).segments, input.name)
      if (input.size > cfg.maxUploadBytes) {
        throw filesError("TOO_LARGE", `«${input.name}» ocupa ${formatBytes(input.size)} y el máximo es ${formatBytes(cfg.maxUploadBytes)}.`)
      }
      if (input.conflict === "overwrite" && cfg.deleteAdminOnly && !user.isAdmin) {
        // Replacing is deleting the old contents: same rule as RM_FILES_DELETE=admins.
        throw filesError("FORBIDDEN", "Solo los administradores pueden reemplazar archivos en este servidor: usa «Conservar ambos».")
      }
      const mine = [...sessions.values()].filter((s) => s.user.id === user.id).length
      if (mine >= maxPerUser || sessions.size >= maxSessions) throw filesError("BUSY", "Hay demasiadas subidas en curso. Espera a que terminen algunas.")
      const p = parseOrThrow(input.dir)
      const r = await root()
      const parent = await folder(r, p.segments)
      const id = crypto.randomBytes(16).toString("hex")
      const tmp = entryAt(parent, `${UPLOAD_TEMP_PREFIX}${id}.part`)
      let fh: fs.promises.FileHandle | null = null
      try {
        const target = await exists(entryAt(parent, input.name))
        if (target && input.conflict === "fail") throw filesError("EXISTS", `Ya existe «${input.name}» en esta carpeta.`, { name: input.name })
        const disk = await statfs(parent.at)
        if (disk) {
          const pending = [...sessions.values()].reduce((n, s) => n + (s.size - s.received), 0)
          if (disk.freeBytes - pending - input.size < reserve) throw filesError("NO_SPACE", noSpaceMessage(disk.freeBytes, input.size))
        }
        // O_EXCL: never an existing file or a link planted under that name.
        fh = await fs.promises.open(tmp, "wx", 0o600)
        await assertFdInside(fh.fd, r)
        await fh.close()
      } catch (e) {
        await fh?.close().catch(() => undefined)
        if (fh) await fs.promises.unlink(tmp).catch(() => undefined)
        await parent.close()
        mapFsError(e, input.name)
      }
      sessions.set(id, {
        id, user, dir: p.path, name: input.name, size: input.size, conflict: input.conflict,
        folder: parent, tmp, received: 0, busy: false, lastActivity: now(),
      })
      return { id, chunkMaxBytes: FILES_CHUNK_MAX_BYTES }
    },

    async uploadChunk(id, userId, offset, body) {
      const s = sessions.get(id)
      if (!s || s.user.id !== userId) throw filesError("NOT_FOUND", "La subida ya no existe (se canceló o caducó). Vuelve a subir el archivo.")
      if (s.busy) throw filesError("BUSY", "Ya se está enviando un fragmento de esta subida.")
      if (offset !== s.received) throw filesError("OFFSET", "El fragmento no continúa donde quedó la subida.", { received: s.received })
      s.busy = true
      s.lastActivity = now()
      const limiter = new Limiter(Math.min(s.size - s.received, FILES_CHUNK_MAX_BYTES))
      const actor: ActorRef = { kind: "user", id: s.user.id, name: s.user.username, ip: s.user.ip }
      try {
        try {
          await writeBody(body, limiter, await openWrite(s.tmp, offset))
        } catch (e) {
          const code = errno(e)
          if (NO_SPACE.has(code)) {
            const disk = await statfs(s.folder.at)
            await dropSession(s)
            audit(actor, "files.upload", joinRel(s.dir, s.name), { path: joinRel(s.dir, s.name), sizeBytes: s.size, reason: "no-space" }, "error")
            log.warn("Subida cancelada: disco lleno", { archivo: joinRel(s.dir, s.name), bytes: s.size })
            throw filesError("NO_SPACE", noSpaceMessage(disk?.freeBytes ?? null))
          }
          if (code === "ENOENT") {
            await dropSession(s)
            throw filesError("NOT_FOUND", "La carpeta de destino ya no existe: alguien la ha movido o borrado.")
          }
          if (filesErrorKind(e)) throw e
          // Client gone or network error: keep the session, the client resumes from `received`.
          throw filesError("INTERNAL", "Se ha interrumpido el envío del fragmento.", { received: s.received })
        }
        s.received += limiter.count
        s.lastActivity = now()
        if (s.received < s.size) return { received: s.received, done: false, name: null, path: null }
        // Complete: exact size, on disk, readable by the group (the service umask is 0027), then committed.
        const fh = await openInside(s.tmp, fs.constants.O_RDWR, await root())
        try {
          await fh.truncate(s.size)
          await fh.sync()
          await fh.chmod(FILE_MODE)
        } finally {
          await fh.close()
        }
        let finalName: string
        try {
          finalName = await commit(s)
        } catch (e) {
          await dropSession(s)
          mapFsError(e, s.name)
        }
        sessions.delete(s.id)
        await s.folder.close()
        const rel = joinRel(s.dir, finalName)
        audit(actor, "files.upload", rel, { path: rel, sizeBytes: s.size, ...(finalName !== s.name ? { requested: s.name } : {}), ...(s.conflict === "overwrite" ? { overwrite: true } : {}) })
        publish([s.dir], "upload", [finalName], s.user.username)
        return { received: s.received, done: true, name: finalName, path: rel }
      } finally {
        s.busy = false
      }
    },

    async uploadCancel(id, userId) {
      const s = sessions.get(id)
      if (!s || s.user.id !== userId) return
      await dropSession(s)
    },

    hasSession: (id) => sessions.has(id),

    realRoot: () => root(),

    async checkFolder(rel) {
      const p = parseOrThrow(rel)
      const d = await folder(await root(), p.segments, "INVALID")
      await d.close()
      return p.path
    },

    async importFile(dirRel, name, src, byName) {
      checkName(name)
      const p = parseOrThrow(dirRel)
      if (p.segments.length === 0 && spec.reserved.includes(name)) throw filesError("INVALID", `«${name}» está reservado para el servidor.`)
      const st = await src.stat()
      if (!st.isFile()) throw filesError("INVALID", "Origen no válido.")
      const size = st.size
      const r = await root()
      const dir = await folder(r, p.segments, "INVALID")
      const tmp = entryAt(dir, `${UPLOAD_TEMP_PREFIX}${crypto.randomBytes(16).toString("hex")}.part`)
      let created = false
      let finalName = name
      try {
        const disk = await statfs(dir.at)
        if (disk && disk.freeBytes - size < reserve) throw filesError("NO_SPACE", noSpaceMessage(disk.freeBytes, size))
        const out = await fs.promises.open(tmp, "wx", 0o600)
        created = true
        try {
          await assertFdInside(out.fd, r)
          const buf = Buffer.allocUnsafe(1024 * 1024)
          let pos = 0
          while (pos < size) {
            const { bytesRead } = await src.read(buf, 0, Math.min(buf.length, size - pos), pos)
            if (bytesRead === 0) throw filesError("INTERNAL", "El archivo generado ha cambiado mientras se guardaba.")
            let off = 0
            while (off < bytesRead) off += (await out.write(buf, off, bytesRead - off, pos + off)).bytesWritten
            pos += bytesRead
          }
          await out.sync()
          await out.chmod(FILE_MODE)
        } finally {
          await out.close()
        }
        let placed = false
        for (let n = 0; n <= 10_000 && !placed; n++) {
          finalName = n === 0 ? name : keepBothName(name, n)
          try {
            await placeNoClobber(tmp, entryAt(dir, finalName))
            placed = true
          } catch (e) {
            if (errno(e) !== "EEXIST") throw e
          }
        }
        if (!placed) throw filesError("EXISTS", `Ya existe «${name}» en esa carpeta.`)
        created = false
      } catch (e) {
        if (created) await fs.promises.unlink(tmp).catch(() => undefined)
        mapFsError(e, name)
      } finally {
        await dir.close()
      }
      const rel = joinRel(p.path, finalName)
      publish([p.path], "upload", [finalName], byName)
      return { name: finalName, path: rel, size }
    },

    async openDownload(rel) {
      const p = parseOrThrow(rel)
      if (!p.segments.length) throw filesError("INVALID", "Elige un archivo.")
      checkReserved(p.segments)
      const r = await root()
      const e = await resolveExisting(r, p.segments)
      if (reservedReal(e.real, r)) throw filesError("NOT_FOUND", NOT_FOUND_MESSAGE)
      if (e.stat.isDirectory()) throw filesError("INVALID", `«${baseName(p.path)}» es una carpeta: descárgala como .zip.`, { isDir: true })
      if (!e.stat.isFile()) throw filesError("NOT_FOUND", NOT_FOUND_MESSAGE)
      let handle: fs.promises.FileHandle
      try {
        // O_NONBLOCK: a FIFO swapped in after the check cannot hang the request; O_NOFOLLOW: nor can a new link.
        handle = await fs.promises.open(e.real, fs.constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
      } catch {
        throw filesError("NOT_FOUND", NOT_FOUND_MESSAGE)
      }
      try {
        const st = await handle.stat()
        if (!st.isFile()) throw filesError("NOT_FOUND", NOT_FOUND_MESSAGE)
        await assertFdInside(handle.fd, r)
        return { handle, size: st.size, mtime: st.mtime, name: baseName(p.path), path: p.path, mode: st.mode }
      } catch (err) {
        await handle.close().catch(() => undefined)
        throw err
      }
    },

    async archiveSource(dirRel, names) {
      const d = parseOrThrow(dirRel)
      const r = await root()
      const tops = [...new Set(names)]
      for (const n of tops) {
        const pn = parseRelPath(n)
        if (!pn.ok || pn.segments.length !== 1 || n.startsWith(UPLOAD_TEMP_PREFIX)) throw filesError("INVALID", "Nombre no válido.")
        if (d.segments.length === 0 && spec.reserved.includes(n)) throw filesError("NOT_FOUND", `«${n}» ya no existe: actualiza la lista.`)
      }
      // Checked now (clear errors before the response starts); walked later through descriptors.
      const check = await folder(r, d.segments)
      try {
        for (const n of tops) {
          if (!(await exists(entryAt(check, n)))) throw filesError("NOT_FOUND", `«${n}» ya no existe: actualiza la lista.`)
        }
      } finally {
        await check.close()
      }
      const baseNameOut = tops.length === 1 ? tops[0] : d.path ? baseName(d.path) : "archivos"
      const skipped: ArchiveSkip[] = []
      let budget = 200_000
      const skip = (p: string, reason: string) => { if (skipped.length < 1000) skipped.push({ path: p, reason }) }

      /** Names in a folder (bounded by what is left of the budget), sorted. */
      async function childrenOf(dir: OpenDir): Promise<string[]> {
        const out: string[] = []
        const atTop = dir.real === r
        const dd = await fs.promises.opendir(dir.at)
        for await (const c of dd) {
          if (c.name.startsWith(UPLOAD_TEMP_PREFIX)) continue
          if (atTop && spec.reserved.includes(c.name)) continue
          if (out.length > budget) break
          out.push(c.name)
        }
        return out.sort()
      }

      /**
       * One entry and, for folders, everything below (depth first, sorted), each folder read through its own open
       * descriptor. Links are followed only to files inside the folder; links to folders are not followed.
       */
      async function* walk(parent: OpenDir, name: string, inArchive: string): AsyncGenerator<ArchiveEntry> {
        if (--budget < 0) {
          if (budget === -1) skip(inArchive, "demasiados elementos (máximo 200 000 por descarga)")
          return
        }
        const full = entryAt(parent, name)
        const l = await fs.promises.lstat(full).catch(() => null)
        if (!l) return
        let target = full
        let st: fs.Stats = l
        if (l.isSymbolicLink()) {
          const rp = await fs.promises.realpath(full).catch(() => null)
          if (!rp) return skip(inArchive, "enlace roto")
          if (!isWithin(rp, r) || reservedReal(rp, r)) return skip(inArchive, "enlace a algo fuera de la carpeta de archivos")
          const s2 = await fs.promises.stat(rp).catch(() => null)
          if (!s2) return skip(inArchive, "enlace roto")
          if (s2.isDirectory()) return skip(inArchive, "enlace a una carpeta (no se sigue)")
          target = rp
          st = s2
        }
        if (st.isDirectory()) {
          const sub = await openDir(full, r).catch(() => null)
          if (!sub) return skip(inArchive, "carpeta ilegible")
          try {
            yield { name: inArchive, kind: "dir", mtime: st.mtime, mode: st.mode & 0o777 }
            let children: string[]
            try {
              children = await childrenOf(sub)
            } catch {
              return skip(inArchive, "carpeta ilegible")
            }
            for (const c of children) yield* walk(sub, c, `${inArchive}/${c}`)
          } finally {
            await sub.close()
          }
          return
        }
        if (!st.isFile()) return skip(inArchive, "fichero especial (no es un fichero normal)")
        yield {
          name: inArchive, kind: "file", mtime: st.mtime, mode: st.mode & 0o777,
          open: async () => {
            let h: fs.promises.FileHandle | null = null
            try {
              h = await fs.promises.open(target, fs.constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
              const hs = await h.stat()
              if (!hs.isFile()) throw new Error("not a file")
              await assertFdInside(h.fd, r)
              const stream = h.createReadStream({ highWaterMark: 256 * 1024, autoClose: true })
              return { size: hs.size, stream, close: () => { stream.destroy() } }
            } catch {
              await h?.close().catch(() => undefined)
              skip(inArchive, "no se puede leer")
              return null
            }
          },
        }
      }

      async function* all(): AsyncGenerator<ArchiveEntry> {
        const top = await folder(r, d.segments)
        try {
          const list = tops.length ? tops : await childrenOf(top)
          for (const n of list) yield* walk(top, n, n)
        } finally {
          await top.close()
        }
        if (skipped.length) {
          // Tell the person what is missing, inside the archive itself.
          const text = Buffer.from([
            "Relay Manager (Archivos): elementos que no se han incluido en este archivo.",
            "",
            ...skipped.map((x) => `${x.path}: ${x.reason}`),
            "",
          ].join("\n"), "utf8")
          yield { name: SKIPPED_REPORT, kind: "file", mtime: new Date(), mode: 0o644, open: async () => ({ size: text.length, stream: [text] }) }
        }
      }
      return { baseName: baseNameOut, entries: all(), skipped }
    },

    sessions: () => sessions.size,

    async sweep() {
      const t = now()
      for (const s of [...sessions.values()]) {
        if (!s.busy && t - s.lastActivity > idleMs) {
          log.info("Subida abandonada: se borra el temporal", { archivo: joinRel(s.dir, s.name) })
          await dropSession(s)
        }
      }
    },

    async start() {
      if (!cfg.enabled) {
        log.info("Archivos desactivado (RM_FILES_ENABLED=0)")
        return
      }
      try {
        if (!fs.existsSync(spec.dir)) {
          fs.mkdirSync(spec.dir, { recursive: true, mode: 0o750 })
          log.info("Carpeta de archivos creada", { carpeta: spec.dir })
        }
      } catch (e) {
        log.warn("No se puede crear la carpeta de archivos", { carpeta: spec.dir, error: errno(e) || String(e) })
      }
      const st = await core.status()
      if (st.problem) log.warn("Carpeta de archivos no disponible", { carpeta: spec.dir, problema: st.problem })
      else log.info("Carpeta de archivos", { carpeta: spec.dir, libre: st.freeBytes === null ? "?" : formatBytes(st.freeBytes) })
      timer = setInterval(() => { void core.sweep().catch(() => undefined) }, internals.sweepEveryMs ?? 60_000)
      timer.unref()
      // Temporary files left by a previous run (crash, power cut): in the background, bounded.
      void root().then((r) => sweepStaleTemps(r)).then((n) => {
        if (n) log.info("Temporales de subidas antiguas borrados", { ficheros: n })
      }, () => undefined)
    },

    async stop() {
      if (timer) clearInterval(timer)
      timer = null
      for (const s of [...sessions.values()]) await dropSession(s)
    },
  }
  return core
}
