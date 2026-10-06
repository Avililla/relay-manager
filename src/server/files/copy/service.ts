// «Archivos › Copiar a una carpeta del servidor» (Graph A, part of rt.files; administrators only): browse the host's
// folders and drives, mount and eject USB sticks, create a folder, and copy files of the folders of Archivos there. As
// the service when it can (read, write), or «como administrador (sudo)» through the root helper (relay-manager-rootcopy,
// protocol.ts) authenticated with the password of the bench's sudo user. The password elevates THIS browser session
// for 5 minutes: the helper issues a signed token bound to the login session and the web user, kept here (never sent
// to the browser) and used for the following requests until it expires or «Olvidar permisos». The service never gains
// privileges: it reads the source from its own folder and streams it to the helper, which writes it as root.
// Queue with limits, progress on the SSE bus to that user only, cancel, audit `files.copy*` (never the password).
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import {
  COPY_ELEVATION_TTL_MS,
  type CopyBrowseDTO, type CopyElevationDTO, type CopyInfoDTO, type CopyJobDTO, type CopyMkdirInput, type CopyMountInput, type CopyMountResultDTO, type CopyRootDTO,
  type CopyStartInput, type CopyState, type CopyUnmountInput, type CopyUnmountResultDTO, type FilesRootId,
} from "@/lib/contracts/files"
import type { JsonValue } from "@/lib/contracts/common"
import type { AppConfig } from "@/server/config/schema"
import type { Logger } from "@/server/log"
import type { AuditService, AuthUser, EventBus } from "@/server/runtime/types"
import type { DownloadSource } from "../core"
import { filesError, filesErrorKind } from "../paths"
import { createHelperClient, HelperUnavailable, type HelperClient } from "./helper-client"
import { aliasesOf, isReadOnly, listDrives, listUnmountedDevices, mountFor, parseMountinfo, systemDrivesDeps, type DrivesDeps } from "./mounts"
import { buildPolicy, denyReason, denyReasonWithAliases, inRoots, normalizeAbs, rootWriteReason, type CopyPolicy } from "./policy"
import { WEB_USER_RE, type HelperAuth, type IssuedToken, type ListResult, type PingResult } from "./protocol"
import { describeMountStatus, describeRootStatus } from "./root-status"
import { canWrite, CopyError, listEntries, mkdirIn, openDestDir, spaceOf, writeIntoDir, type ListedEntry } from "./safe-dest"

export interface CopyDeps {
  config: Pick<AppConfig, "mode" | "copy" | "files" | "dataDir" | "backupDir" | "captureDir" | "dbFile" | "appDir" | "bundleRoot" | "serial">
  log: Logger
  bus: EventBus
  audit: AuditService
  /** A file of a root of Archivos, opened through that root's files core (path rules, descriptor checks). */
  openSource(root: FilesRootId, rel: string): Promise<DownloadSource>
}

export interface CopyInternals {
  helper?: HelperClient | null
  drives?: DrivesDeps
  mountinfo?: () => Promise<string>
  maxActivePerUser?: number
  maxActive?: number
  maxPendingPerUser?: number
  progressMs?: number
  keepFinishedMs?: number
  pingCacheMs?: number
  now?: () => number
}

/**
 * Who asks: the web user, their IP and the id of their login session (sessionIdOf: the elevation of «como
 * administrador» belongs to that browser session only).
 */
export interface CopyViewer { user: AuthUser; ip: string | null; sid: string }

/** sha256(user id : session version : login time), hex: identifies one login session (one browser). */
export function sessionIdOf(s: { user: { id: string }; sv: number; loginAt: number }): string {
  return crypto.createHash("sha256").update(`${s.user.id}:${s.sv}:${s.loginAt}`).digest("hex")
}

/**
 * Every method checks «administrator» and RM_COPY_ENABLED itself. `password: null` (as root) means «use this session's
 * elevation»; without one (or expired) → 403 FORBIDDEN with `needsPassword: true` and `field: "password"`.
 */
export interface CopyService {
  info(v: CopyViewer): Promise<CopyInfoDTO>
  /** As the service; when it cannot read the folder and the session is elevated, lists it through the helper. */
  browse(v: CopyViewer, path: string, hidden: boolean): Promise<CopyBrowseDTO>
  browseAsRoot(v: CopyViewer, path: string, hidden: boolean, password: string | null): Promise<CopyBrowseDTO>
  mkdir(v: CopyViewer, input: CopyMkdirInput): Promise<{ path: string; elevation: CopyElevationDTO | null }>
  start(v: CopyViewer, input: CopyStartInput): Promise<{ jobs: CopyJobDTO[]; elevation: CopyElevationDTO | null }>
  mount(v: CopyViewer, input: CopyMountInput): Promise<CopyMountResultDTO>
  unmount(v: CopyViewer, input: CopyUnmountInput): Promise<CopyUnmountResultDTO>
  /** «Olvidar permisos»: drops this session's elevation (and revokes the token in the helper). */
  forget(v: CopyViewer): Promise<void>
  jobs(userId: string): CopyJobDTO[]
  cancel(userId: string, id: string): boolean
  clearFinished(userId: string): void
  /** For Sistema › Salud and doctor. */
  rootStatus(): Promise<CopyRootDTO>
  stats(): { active: number; queued: number }
  stop(): Promise<void>
}

/** The authentication of a batch of root copies: the password (kept in memory until its last copy) or the token. */
interface Batch { auth: HelperAuth | null; pending: number }

interface Job {
  dto: CopyJobDTO
  user: { id: string; username: string; ip: string | null }
  root: FilesRootId
  rel: string
  /** Real path of the destination (checked when queued and again when the copy starts). */
  dest: string
  batch: Batch
  ac: AbortController
  abortReason: string | null
  lastPublish: number
  sample: { t: number; bytes: number } | null
  done: Promise<void> | null
}

/** One browser session's elevation: the helper's token (never leaves the server). */
interface Elevation { token: string; expiresAt: number; userId: string; rootUser: string }

const ACTIVE: ReadonlySet<CopyState> = new Set(["copying", "verifying"])
const FINISHED: ReadonlySet<CopyState> = new Set(["done", "skipped", "error", "canceled"])
const errno = (e: unknown) => (e as NodeJS.ErrnoException | null)?.code ?? ""

const ADMINS_ONLY = "Solo los administradores pueden copiar a carpetas del servidor."

/** Root helper error code → files error kind (HTTP status) and the form field it belongs to. */
function helperErrorToFiles(e: CopyError): Error {
  switch (e.code) {
    case "AUTH": case "LOCKED": return filesError("FORBIDDEN", e.message, { field: "password", auth: e.code })
    case "TOKEN": return filesError("FORBIDDEN", e.message, { field: "password", needsPassword: true })
    case "ACCOUNT": return filesError("UNAVAILABLE", e.message, { field: "password", auth: e.code })
    case "DENIED": case "ACCESS": case "READ_ONLY": case "DEVICE": return filesError("FORBIDDEN", e.message)
    case "NOT_FOUND": return filesError("NOT_FOUND", e.message)
    case "EXISTS": return filesError("EXISTS", e.message)
    case "NO_SPACE": return filesError("NO_SPACE", e.message)
    case "INVALID": case "PROTOCOL": return filesError("INVALID", e.message)
    case "BUSY": case "IN_USE": return filesError("BUSY", e.message)
    case "DISABLED": case "NO_MOUNT": return filesError("UNAVAILABLE", e.message)
    default: return filesError("UNAVAILABLE", e.message)
  }
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString())
const foldersOf = (entries: readonly ListedEntry[]) => entries.filter((e) => e.kind === "dir").map((e) => ({ name: e.name, hidden: e.hidden, link: e.link }))
const filesOf = (entries: readonly ListedEntry[]) => entries.filter((e) => e.kind === "file")
  .map((e) => ({ name: e.name, hidden: e.hidden, link: e.link, size: e.size, mtime: iso(e.mtimeMs) }))

export function createCopyService(deps: CopyDeps, internals: CopyInternals = {}): CopyService {
  const cfg = deps.config.copy
  const log = deps.log.child("copias")
  const now = internals.now ?? (() => Date.now())
  const maxPerUser = internals.maxActivePerUser ?? 2
  const maxActive = internals.maxActive ?? 3
  const maxPending = internals.maxPendingPerUser ?? 40
  const progressMs = internals.progressMs ?? 500
  const keepMs = internals.keepFinishedMs ?? 3600_000
  const pingCacheMs = internals.pingCacheMs ?? 10_000
  const helper: HelperClient | null = internals.helper !== undefined ? internals.helper : cfg.helperSocket ? createHelperClient(cfg.helperSocket) : null
  const drives = internals.drives ?? systemDrivesDeps(deps.config.serial.sysRoot, deps.config.serial.devRoot, cfg.testRemovable)
  const mountinfo = internals.mountinfo ?? (() => fs.promises.readFile("/proc/self/mountinfo", "utf8"))
  const c = deps.config
  // The app's own folders (the native config.env lives in /etc, denied anyway; a portable one is in the bundle root).
  const policy: CopyPolicy = buildPolicy(cfg.roots, cfg.deny, [
    c.dataDir, c.backupDir, c.captureDir, path.dirname(c.dbFile), c.appDir, c.bundleRoot,
  ].filter((d): d is string => !!d && d !== "/"))
  const jobs = new Map<string, Job>()
  const elevations = new Map<string, Elevation>()
  let stopped = false
  let pingCache: { at: number; value: Promise<PingResult | Error> } | null = null

  // --- authorisation and audit -----------------------------------------------------------------------------------

  const actorOf = (v: CopyViewer) => ({ kind: "user" as const, id: v.user.id, name: v.user.username, ip: v.ip })

  function requireAdmin(v: CopyViewer, what: string): void {
    if (!cfg.enabled) throw filesError("DISABLED", "La copia a carpetas del servidor está desactivada (RM_COPY_ENABLED=0).")
    if (v.user.isAdmin) return
    deps.audit.record({ actor: actorOf(v), action: "files.copy", outcome: "denied", target: { type: "file", id: null, name: what }, detail: { motivo: "no es administrador" } })
    throw filesError("FORBIDDEN", ADMINS_ONLY)
  }

  function auditDenied(v: CopyViewer, dest: string, op: string, e: CopyError, action: "files.copy" | "files.copy.mount" | "files.copy.unmount" = "files.copy"): void {
    deps.audit.record({
      actor: actorOf(v), action, outcome: "denied", target: { type: "file", id: null, name: dest },
      detail: { op, asRoot: true, rootUser: cfg.sudoUser, error: e.message, code: e.code },
    })
  }

  // --- the root helper -------------------------------------------------------------------------------------------

  function ping(): Promise<PingResult | Error> {
    if (!helper) return Promise.resolve(new HelperUnavailable("sin ayudante"))
    if (pingCache && now() - pingCache.at < pingCacheMs) return pingCache.value
    const value = helper.ping().catch((e: unknown) => (e instanceof Error ? e : new Error(String(e))))
    pingCache = { at: now(), value }
    return value
  }

  const pingOrNull = () => (helper && cfg.enabled && c.mode !== "docker" ? ping() : Promise.resolve(null))

  async function rootStatus(): Promise<CopyRootDTO> {
    return describeRootStatus(c, await pingOrNull())
  }

  async function needHelper(): Promise<HelperClient> {
    const st = await rootStatus()
    if (!st.available || !helper) throw filesError("UNAVAILABLE", st.problem ?? "La copia como administrador no está disponible.", st.hint ? { hint: st.hint } : {})
    return helper
  }

  const rootUserName = async () => (await ping().then((x) => (x instanceof Error ? null : x.user)).catch(() => null)) ?? cfg.sudoUser ?? "root"

  // --- elevation of a browser session ------------------------------------------------------------------------------

  function elevationOf(v: CopyViewer): Elevation | null {
    const t = now()
    for (const [sid, e] of elevations) if (e.expiresAt <= t) elevations.delete(sid)
    const e = elevations.get(v.sid)
    if (!e || e.userId !== v.user.id) return null
    return e
  }
  const elevationDto = (v: CopyViewer): CopyElevationDTO | null => {
    const e = elevationOf(v)
    return e ? { until: new Date(e.expiresAt).toISOString(), user: e.rootUser } : null
  }
  const sessionOf = (v: CopyViewer) => ({ sid: v.sid, webUser: v.user.id })

  async function needsPassword(message?: string): Promise<Error> {
    return filesError("FORBIDDEN", message ?? `Escribe la contraseña de ${await rootUserName()} (sudo).`, { needsPassword: true, field: "password" })
  }

  /** How a request «como administrador» authenticates: the password (asking for a token) or this session's token. */
  async function authFor(v: CopyViewer, password: string | null): Promise<HelperAuth> {
    if (password) return WEB_USER_RE.test(v.user.id) ? { password, session: sessionOf(v), issue: true } : { password }
    const e = elevationOf(v)
    if (!e) throw await needsPassword()
    return { token: e.token, session: sessionOf(v) }
  }

  /** Keeps the token the helper issued with a result (password + issue): this session is elevated until it expires. */
  async function absorb(v: CopyViewer, token: IssuedToken | undefined): Promise<void> {
    if (!token) return
    const rootUser = await rootUserName()
    elevations.set(v.sid, { token: token.value, expiresAt: Math.min(token.expiresAt, now() + COPY_ELEVATION_TTL_MS), userId: v.user.id, rootUser })
    deps.audit.record({
      actor: actorOf(v), action: "files.copy.elevate", target: { type: "user", id: v.user.id, name: v.user.username },
      detail: { rootUser, until: new Date(token.expiresAt).toISOString() },
    })
  }

  /** A helper failure → the files error; a refused token drops the elevation (the dialog asks the password again). */
  async function helperFailure(v: CopyViewer, e: unknown, target: string, op: string, action?: "files.copy" | "files.copy.mount" | "files.copy.unmount"): Promise<never> {
    if (e instanceof CopyError) {
      if (e.code === "TOKEN") {
        elevations.delete(v.sid)
        throw await needsPassword(e.message)
      }
      if (e.code === "AUTH" || e.code === "LOCKED") auditDenied(v, target, op, e, action)
      throw helperErrorToFiles(e)
    }
    if (e instanceof HelperUnavailable) throw filesError("UNAVAILABLE", e.message)
    throw e
  }

  // --- destinations ---------------------------------------------------------------------------------------------

  function parseDest(raw: string): string {
    const p = normalizeAbs(raw)
    if (!p) throw filesError("INVALID", "Ruta no válida: escribe una ruta absoluta (empieza por /).", { field: "path" })
    if (!inRoots(p, policy)) throw filesError("FORBIDDEN", `Fuera de las carpetas permitidas (${policy.roots.join(", ")}; RM_COPY_ROOTS).`)
    return p
  }

  async function realOf(p: string): Promise<string | null> {
    try {
      return await fs.promises.realpath(p)
    } catch (e) {
      if (errno(e) === "ENOENT" || errno(e) === "ENOTDIR") throw filesError("NOT_FOUND", `No existe «${p}» (¿se ha quitado el disco?).`)
      if (errno(e) === "EACCES") return null
      throw e
    }
  }

  async function readOnlyMountOf(real: string): Promise<boolean> {
    try {
      const m = mountFor(real, parseMountinfo(await mountinfo()))
      return m ? isReadOnly(m) : false
    } catch {
      return false
    }
  }

  /** The deny-list on the real path and on its other names (a bind mount of a system folder is still that folder). */
  async function deniedFor(real: string): Promise<string | null> {
    let aliases: string[] = []
    try {
      aliases = aliasesOf(real, parseMountinfo(await mountinfo()))
    } catch {
      // no mountinfo: the real path alone
    }
    return denyReasonWithAliases(real, aliases, policy)
  }

  const parentOf = (p: string) => (p === "/" ? null : inRoots(path.dirname(p), policy) ? path.dirname(p) : null)

  /** A folder listed by the root helper (folders and files, metadata only). */
  async function listAsRoot(v: CopyViewer, p: string, hidden: boolean, password: string | null): Promise<CopyBrowseDTO> {
    const h = await needHelper()
    const auth = await authFor(v, password)
    let r: ListResult & { token?: IssuedToken }
    try {
      r = await h.list({ dir: p, hidden, ...auth })
    } catch (e) {
      return helperFailure(v, e, p, "browse")
    } finally {
      auth.password = undefined
    }
    await absorb(v, r.token)
    return {
      path: r.real, parent: parentOf(r.real), readable: true, writable: false, denied: await deniedFor(r.real), rootWritable: r.writable,
      readOnlyMount: !r.writable && (await readOnlyMountOf(r.real)), folders: foldersOf(r.entries), files: filesOf(r.entries),
      truncated: r.truncated, freeBytes: r.freeBytes, totalBytes: r.totalBytes, asRoot: true, needsElevation: false, elevation: elevationDto(v),
    }
  }

  // --- jobs ------------------------------------------------------------------------------------------------------

  function publish(job: Job, force = false): void {
    const t = now()
    if (!force && t - job.lastPublish < progressMs) return
    job.lastPublish = t
    deps.bus.publish({ type: "files.copy", job: { ...job.dto } }, { kind: "user", userId: job.user.id })
  }
  function setState(job: Job, state: CopyState): void {
    job.dto.state = state
    if (FINISHED.has(state)) job.dto.finishedAt = new Date(now()).toISOString()
    publish(job, true)
  }
  function progress(job: Job, n: number): void {
    const t = now()
    job.dto.copied = n
    const s = job.sample
    if (!s) job.sample = { t, bytes: n }
    else if (t - s.t >= 250) {
      const inst = ((n - s.bytes) / (t - s.t)) * 1000
      job.dto.speed = job.dto.speed > 0 ? Math.round(job.dto.speed * 0.7 + inst * 0.3) : Math.round(inst)
      job.sample = { t, bytes: n }
    }
    publish(job)
  }
  const activeOf = (userId?: string) => [...jobs.values()].filter((j) => ACTIVE.has(j.dto.state) && (!userId || j.user.id === userId))

  function prune(): void {
    const t = now()
    const perUser = new Map<string, Job[]>()
    for (const j of jobs.values()) {
      if (!FINISHED.has(j.dto.state)) continue
      if (j.dto.finishedAt && t - Date.parse(j.dto.finishedAt) > keepMs) {
        jobs.delete(j.dto.id)
        continue
      }
      perUser.set(j.user.id, [...(perUser.get(j.user.id) ?? []), j])
    }
    for (const list of perUser.values()) for (const j of list.slice(0, Math.max(0, list.length - 50))) jobs.delete(j.dto.id)
  }

  function pump(): void {
    if (stopped) return
    for (const j of jobs.values()) {
      if (j.dto.state !== "queued") continue
      if (activeOf().length >= maxActive) return
      if (activeOf(j.user.id).length >= maxPerUser) continue
      j.dto.state = "copying"
      j.done = run(j).catch((err: unknown) => log.error("Error inesperado en una copia", { err })).finally(() => {
        prune()
        pump()
      })
    }
  }

  /** The source file read by position, `size` bytes, hashed on the way (the helper's / disk's sha256 must match). */
  function chunksOf(src: DownloadSource, hash: crypto.Hash): AsyncIterable<Buffer> {
    const size = src.size
    const handle = src.handle
    return {
      async *[Symbol.asyncIterator]() {
        let pos = 0
        while (pos < size) {
          const buf = Buffer.allocUnsafe(Math.min(1024 * 1024, size - pos))
          const { bytesRead } = await handle.read(buf, 0, buf.length, pos)
          if (bytesRead === 0) throw new CopyError("IO", "El archivo de origen ha cambiado de tamaño mientras se copiaba.")
          pos += bytesRead
          const out = bytesRead === buf.length ? buf : buf.subarray(0, bytesRead)
          hash.update(out)
          yield out
        }
      },
    }
  }

  function releaseBatch(b: Batch): void {
    b.pending--
    if (b.pending <= 0) b.auth = null
  }

  async function run(job: Job): Promise<void> {
    publish(job, true)
    let src: DownloadSource | null = null
    let failure: CopyError | null = null
    try {
      src = await deps.openSource(job.root, job.rel).catch((e: unknown) => {
        throw new CopyError("NOT_FOUND", e instanceof Error ? e.message : String(e))
      })
      if (src.size !== job.dto.size) job.dto.size = src.size
      const hash = crypto.createHash("sha256")
      if (job.dto.asRoot) {
        const auth = job.batch.auth
        if (!helper || !auth) throw new CopyError("CANCELED", "Copia cancelada: falta la contraseña.")
        let r
        try {
          r = await helper.copy(
            { dir: job.dest, name: job.dto.name, size: src.size, conflict: job.dto.conflict, ...auth },
            {
              size: src.size, chunks: chunksOf(src, hash), signal: job.ac.signal,
              onProgress: (n) => progress(job, n),
              onVerifying: () => setState(job, "verifying"),
            },
          )
        } catch (e) {
          if (e instanceof CopyError && e.code === "TOKEN") {
            throw new CopyError("TOKEN", "Los permisos de administrador han caducado antes de terminar esta copia: vuelve a copiarla (pedirá la contraseña).")
          }
          throw e
        }
        if (r.skipped) {
          job.dto.finalName = null
          setState(job, "skipped")
          return
        }
        const local = hash.digest("hex")
        if (r.sha256 !== local) throw new CopyError("VERIFY", "La copia no coincide con el original (sha256).")
        job.dto.finalName = r.name
        job.dto.replaced = r.replaced
        job.dto.sha256 = r.sha256
      } else {
        const dir = await openDestDir(job.dest)
        try {
          const why = await deniedFor(dir.real)
          if (why) throw new CopyError("DENIED", why)
          const r = await writeIntoDir(dir, job.dto.name, job.dto.conflict, {
            size: src.size, source: chunksOf(src, hash), mode: 0o644, owner: null, signal: job.ac.signal,
            onProgress: (n) => progress(job, n),
            onVerifying: () => setState(job, "verifying"),
          })
          if (r.skipped) {
            setState(job, "skipped")
            return
          }
          job.dto.finalName = r.name
          job.dto.replaced = r.replaced
          job.dto.sha256 = r.sha256
        } finally {
          await dir.close()
        }
      }
      // The source must not have changed size while it was read.
      const st = await src.handle.stat()
      if (st.size !== job.dto.size) throw new CopyError("IO", "El archivo de origen ha cambiado mientras se copiaba: vuelve a copiarlo.")
      job.dto.copied = job.dto.size
      setState(job, "done")
    } catch (e) {
      failure = e instanceof CopyError ? e : e instanceof HelperUnavailable ? new CopyError("IO", e.message) : new CopyError("IO", `Error interno (ref ${crypto.randomBytes(4).toString("hex")}).`)
      if (!(e instanceof CopyError) && !(e instanceof HelperUnavailable)) log.error("Error interno en una copia", { err: e })
      const canceled = failure.code === "CANCELED" || job.ac.signal.aborted
      job.dto.error = job.abortReason ?? (canceled ? "Copia cancelada." : failure.message)
      setState(job, canceled ? "canceled" : "error")
    } finally {
      await src?.handle.close().catch(() => undefined)
      releaseBatch(job.batch)
      auditJob(job, failure)
      log.info(job.dto.state === "done" ? "Archivo copiado a una carpeta del servidor" : "Copia a una carpeta del servidor sin terminar", {
        usuario: job.user.username, raiz: job.root, archivo: job.rel, destino: job.dto.destDir, comoRoot: job.dto.asRoot, estado: job.dto.state,
        ...(job.dto.error ? { causa: job.dto.error } : {}),
      })
    }
  }

  function auditJob(job: Job, failure: CopyError | null): void {
    const d = job.dto
    const detail: Record<string, JsonValue> = {
      root: job.root, path: job.rel, sizeBytes: d.size, dest: d.destDir, asRoot: d.asRoot, conflict: d.conflict,
      result: d.state === "done" ? "copiado" : d.state === "skipped" ? "omitido" : d.state === "canceled" ? "cancelado" : "error",
    }
    if (d.asRoot) detail.rootUser = d.rootUser
    if (d.finalName) detail.finalName = d.finalName
    if (d.state === "done") {
      detail.replaced = d.replaced
      detail.checksum = `verificado (sha256 ${d.sha256 ?? ""})`
    }
    if (failure && d.state !== "canceled") detail.error = d.error
    if (failure) detail.code = failure.code
    deps.audit.record({
      actor: { kind: "user", id: job.user.id, name: job.user.username, ip: job.user.ip }, action: "files.copy",
      outcome: d.state === "done" || d.state === "skipped" ? "ok" : failure?.code === "AUTH" || failure?.code === "LOCKED" ? "denied" : "error",
      target: { type: "file", id: null, name: job.rel }, detail,
    })
  }

  const dtoFor = (userId: string) => [...jobs.values()].filter((j) => j.user.id === userId).map((j) => ({ ...j.dto }))

  // --- the API ---------------------------------------------------------------------------------------------------

  return {
    async info(v) {
      requireAdmin(v, "/")
      const pingR = await pingOrNull()
      const root = describeRootStatus(c, pingR)
      const mount = describeMountStatus(root, pingR)
      const [list, devices] = await Promise.all([
        listDrives(drives),
        mount.available ? listUnmountedDevices(drives).catch(() => []) : Promise.resolve([]),
      ])
      return {
        roots: [...policy.roots], drives: list.filter((d) => inRoots(d.mountPoint, policy)).map((d) => ({ ...d, ejectable: d.ejectable && mount.available })),
        devices, root, mount, elevation: elevationDto(v),
      }
    },

    async browse(v, raw, hidden) {
      requireAdmin(v, raw)
      const p = parseDest(raw)
      const real = await realOf(p)
      const shown = real ?? p
      if (real && !inRoots(real, policy)) throw filesError("FORBIDDEN", `«${p}» lleva fuera de las carpetas permitidas (RM_COPY_ROOTS).`)
      const denied = real ? await deniedFor(real) : denyReason(shown, policy)
      const st = await rootStatus()
      const rootWritable = !denied && rootWriteReason(shown, cfg.rootPaths) === null && st.available
      const out: CopyBrowseDTO = {
        path: shown, parent: parentOf(shown), readable: false, writable: false, denied, rootWritable, readOnlyMount: false,
        folders: [], files: [], truncated: false, freeBytes: null, totalBytes: null, asRoot: false, needsElevation: false, elevation: elevationDto(v),
      }
      /** The service cannot read it: through the helper when this session is elevated, else ask for the password. */
      const unreadable = async (): Promise<CopyBrowseDTO> => {
        if (st.available && elevationOf(v)) {
          try {
            return await listAsRoot(v, p, hidden, null)
          } catch (e) {
            if ((e as { details?: { needsPassword?: unknown } }).details?.needsPassword !== true) throw e
          }
        }
        return { ...out, needsElevation: st.available, elevation: elevationDto(v) }
      }
      if (!real) return unreadable()
      out.readOnlyMount = await readOnlyMountOf(real)
      let dir
      try {
        dir = await openDestDir(real)
      } catch (e) {
        if (e instanceof CopyError && e.code === "ACCESS") return unreadable()
        if (e instanceof CopyError) throw e.code === "NOT_FOUND" ? filesError("NOT_FOUND", e.message) : filesError("INVALID", e.message)
        throw e
      }
      try {
        const listed = await listEntries(dir, hidden).catch((e: unknown) => {
          if (e instanceof CopyError && e.code === "ACCESS") return null
          throw e
        })
        if (!listed) return await unreadable()
        const space = await spaceOf(dir)
        return {
          ...out, readable: true, writable: !denied && !out.readOnlyMount && (await canWrite(dir)),
          folders: foldersOf(listed.entries), files: filesOf(listed.entries), truncated: listed.truncated,
          freeBytes: space?.freeBytes ?? null, totalBytes: space?.totalBytes ?? null,
        }
      } finally {
        await dir.close()
      }
    },

    async browseAsRoot(v, raw, hidden, password) {
      requireAdmin(v, raw)
      return listAsRoot(v, parseDest(raw), hidden, password)
    },

    async mkdir(v, input) {
      requireAdmin(v, input.dir)
      const p = parseDest(input.dir)
      const actor = actorOf(v)
      let created: string
      if (input.asRoot) {
        const h = await needHelper()
        const auth = await authFor(v, input.password)
        try {
          const r = await h.mkdir({ dir: p, name: input.name, ...auth })
          created = r.real
          await absorb(v, r.token)
        } catch (e) {
          if (e instanceof CopyError && (e.code === "INVALID" || e.code === "EXISTS")) {
            throw filesError(e.code === "EXISTS" ? "EXISTS" : "INVALID", e.message, { field: "name" })
          }
          return helperFailure(v, e, p, "mkdir")
        } finally {
          auth.password = undefined
        }
      } else {
        const real = await realOf(p)
        if (!real) throw filesError("FORBIDDEN", "El servicio no puede abrir esa carpeta: créala como administrador (sudo).", { needsRoot: true })
        const why = await deniedFor(real)
        if (why) throw filesError("FORBIDDEN", why)
        const dir = await openDestDir(real).catch((e: unknown) => {
          throw e instanceof CopyError ? filesError(e.code === "ACCESS" ? "FORBIDDEN" : "NOT_FOUND", e.message, e.code === "ACCESS" ? { needsRoot: true } : {}) : e
        })
        try {
          created = await mkdirIn(dir, input.name, null)
        } catch (e) {
          if (e instanceof CopyError) {
            if (e.code === "ACCESS" || e.code === "READ_ONLY") throw filesError("FORBIDDEN", "El servicio no puede escribir en esa carpeta: créala como administrador (sudo).", { needsRoot: e.code === "ACCESS" })
            throw filesError(e.code === "EXISTS" ? "EXISTS" : "INVALID", e.message, { field: "name" })
          }
          throw e
        } finally {
          await dir.close()
        }
      }
      deps.audit.record({ actor, action: "files.copy.mkdir", target: { type: "file", id: null, name: created }, detail: { path: created, asRoot: input.asRoot, ...(input.asRoot ? { rootUser: cfg.sudoUser } : {}) } })
      return { path: created, elevation: elevationDto(v) }
    },

    async start(v, input) {
      requireAdmin(v, input.destDir)
      if (stopped) throw filesError("UNAVAILABLE", "El servidor se está deteniendo.")
      const p = parseDest(input.destDir)
      let dest: string
      let rootUser: string | null = null
      let batchAuth: HelperAuth | null = null
      if (input.asRoot) {
        const h = await needHelper()
        const auth = await authFor(v, input.password)
        try {
          // Authenticates and checks the destination before anything is queued (a wrong password fails here).
          const r = await h.probe({ dir: p, list: false, hidden: false, ...auth })
          dest = r.real
          await absorb(v, r.token)
        } catch (e) {
          auth.password = undefined
          return helperFailure(v, e, p, "copy")
        }
        // The copies use the password while it is in memory (until the last one), else this session's token.
        batchAuth = input.password ? { password: input.password } : { token: auth.token, session: auth.session }
        auth.password = undefined
        rootUser = await rootUserName()
      } else {
        const real = await realOf(p)
        const needsRoot = (msg: string) => filesError("FORBIDDEN", msg, { needsRoot: true })
        if (!real) throw needsRoot("El servicio no puede abrir esa carpeta: copia como administrador (sudo).")
        const why = await deniedFor(real)
        if (why) throw filesError("FORBIDDEN", why)
        const dir = await openDestDir(real).catch((e: unknown) => {
          if (e instanceof CopyError && e.code === "ACCESS") throw needsRoot("El servicio no puede abrir esa carpeta: copia como administrador (sudo).")
          throw e instanceof CopyError ? filesError(e.code === "NOT_FOUND" ? "NOT_FOUND" : "INVALID", e.message) : e
        })
        try {
          if (await readOnlyMountOf(real)) throw filesError("FORBIDDEN", "Ese disco está montado en solo lectura.")
          if (!(await canWrite(dir))) throw needsRoot(`El servicio no puede escribir en ${real}: copia como administrador (sudo).`)
        } finally {
          await dir.close()
        }
        dest = real
      }

      const pending = [...jobs.values()].filter((j) => j.user.id === v.user.id && !FINISHED.has(j.dto.state)).length
      if (pending + input.paths.length > maxPending) throw filesError("BUSY", `Ya tienes ${pending} copias pendientes: espera a que terminen.`)
      const files: Array<{ rel: string; name: string; size: number }> = []
      for (const rel of [...new Set(input.paths)]) {
        const src = await deps.openSource(input.root, rel).catch((e: unknown) => {
          if (filesErrorKind(e) === "INVALID" && (e as { details?: { isDir?: unknown } }).details?.isDir === true) {
            throw filesError("INVALID", `«${rel.split("/").pop() ?? rel}» es una carpeta: solo se copian archivos.`)
          }
          throw e
        })
        await src.handle.close().catch(() => undefined)
        files.push({ rel: src.path, name: src.name, size: src.size })
      }
      const batch: Batch = { auth: batchAuth, pending: files.length }
      const created: Job[] = []
      for (const f of files) {
        const id = crypto.randomBytes(16).toString("hex")
        const job: Job = {
          dto: {
            id, root: input.root, path: f.rel, name: f.name, size: f.size, copied: 0, speed: 0, state: "queued", destDir: dest, finalName: null,
            conflict: input.conflict, asRoot: input.asRoot, rootUser, replaced: false, sha256: null, error: null,
            createdAt: new Date(now()).toISOString(), finishedAt: null,
          },
          user: { id: v.user.id, username: v.user.username, ip: v.ip }, root: input.root, rel: f.rel, dest, batch,
          ac: new AbortController(), abortReason: null, lastPublish: 0, sample: null, done: null,
        }
        jobs.set(id, job)
        created.push(job)
        publish(job, true)
      }
      if (!files.length) batch.auth = null
      pump()
      return { jobs: created.map((j) => ({ ...j.dto })), elevation: elevationDto(v) }
    },

    async mount(v, input) {
      requireAdmin(v, input.device)
      const h = await needHelper()
      const auth = await authFor(v, input.password)
      let r
      try {
        r = await h.mount({ device: input.device, ...auth })
      } catch (e) {
        if (e instanceof CopyError && !["AUTH", "LOCKED", "TOKEN"].includes(e.code)) {
          deps.audit.record({
            actor: actorOf(v), action: "files.copy.mount", outcome: "error", target: { type: "file", id: null, name: input.device },
            detail: { device: input.device, rootUser: cfg.sudoUser, error: e.message, code: e.code },
          })
        }
        return helperFailure(v, e, input.device, "mount", "files.copy.mount")
      } finally {
        auth.password = undefined
      }
      await absorb(v, r.token)
      const serviceWritable = await fs.promises.access(r.mountPoint, fs.constants.W_OK | fs.constants.X_OK).then(() => true, () => false)
      const rootUser = await rootUserName()
      deps.audit.record({
        actor: actorOf(v), action: "files.copy.mount", target: { type: "file", id: null, name: r.mountPoint },
        detail: { device: r.device, mountPoint: r.mountPoint, fsType: r.fsType, options: r.options, rootUser, serviceWritable },
      })
      log.info("Pendrive montado", { usuario: v.user.username, dispositivo: r.device, carpeta: r.mountPoint, tipo: r.fsType })
      return { device: r.device, mountPoint: r.mountPoint, fsType: r.fsType, serviceWritable, elevation: elevationDto(v) }
    },

    async unmount(v, input) {
      requireAdmin(v, input.mountPoint)
      const mp = normalizeAbs(input.mountPoint)
      if (!mp) throw filesError("INVALID", "Ruta no válida.", { field: "mountPoint" })
      const h = await needHelper()
      const auth = await authFor(v, input.password)
      let r
      try {
        r = await h.unmount({ mountPoint: mp, ...auth })
      } catch (e) {
        if (e instanceof CopyError && !["AUTH", "LOCKED", "TOKEN"].includes(e.code)) {
          deps.audit.record({
            actor: actorOf(v), action: "files.copy.unmount", outcome: "error", target: { type: "file", id: null, name: mp },
            detail: { mountPoint: mp, rootUser: cfg.sudoUser, error: e.message, code: e.code },
          })
        }
        return helperFailure(v, e, mp, "unmount", "files.copy.unmount")
      } finally {
        auth.password = undefined
      }
      await absorb(v, r.token)
      deps.audit.record({
        actor: actorOf(v), action: "files.copy.unmount", target: { type: "file", id: null, name: r.mountPoint },
        detail: { mountPoint: r.mountPoint, removedDir: r.removedDir, rootUser: await rootUserName() },
      })
      log.info("Pendrive expulsado", { usuario: v.user.username, carpeta: r.mountPoint })
      return { mountPoint: r.mountPoint, removedDir: r.removedDir, elevation: elevationDto(v) }
    },

    async forget(v) {
      const e = elevations.get(v.sid)
      elevations.delete(v.sid)
      if (!e) return
      if (helper) await helper.revoke(e.token).catch(() => undefined)
      deps.audit.record({ actor: actorOf(v), action: "files.copy.forget", target: { type: "user", id: v.user.id, name: v.user.username }, detail: { rootUser: e.rootUser } })
    },

    jobs: (userId) => dtoFor(userId),

    cancel(userId, id) {
      const j = jobs.get(id)
      if (!j || j.user.id !== userId) return false
      if (FINISHED.has(j.dto.state)) return true
      if (j.dto.state === "queued") {
        j.dto.error = "Copia cancelada."
        setState(j, "canceled")
        releaseBatch(j.batch)
        auditJob(j, new CopyError("CANCELED", "Copia cancelada."))
        prune()
        return true
      }
      j.ac.abort()
      return true
    },

    clearFinished(userId) {
      for (const j of [...jobs.values()]) if (j.user.id === userId && FINISHED.has(j.dto.state)) jobs.delete(j.dto.id)
    },

    rootStatus,

    stats: () => ({ active: activeOf().length, queued: [...jobs.values()].filter((j) => j.dto.state === "queued").length }),

    async stop() {
      stopped = true
      elevations.clear()
      const running = [...jobs.values()].filter((j) => !FINISHED.has(j.dto.state))
      for (const j of running) {
        j.abortReason = "El servidor se ha detenido: copia cancelada."
        if (j.dto.state === "queued") {
          j.dto.error = j.abortReason
          setState(j, "canceled")
          releaseBatch(j.batch)
        } else j.ac.abort()
      }
      await Promise.race([Promise.all(running.map((j) => j.done)), new Promise((r) => setTimeout(r, 3000).unref())])
    },
  }
}
