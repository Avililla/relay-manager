// "Archivos" HTTP API (Graph A, before Next): list, download (Range), zip, chunked upload. Served by the custom
// server because Next would buffer or cap request bodies (proxy.ts) and may compress responses (breaking
// Content-Length and Range). The Origin gate of the request listener has already run for PUT/POST/DELETE.
// Cookie authentication with a fresh user (same as the WebSocket handshake).
import crypto from "node:crypto"
import type { IncomingMessage, ServerResponse } from "node:http"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import zlib from "node:zlib"
import {
  ARCHIVE_FORMATS, CopyBrowseRootSchema, CopyMkdirSchema, CopyMountSchema, CopyStartSchema, CopyUnmountSchema, ExportStartSchema, FILES_API,
  FILES_CHUNK_MAX_BYTES, FILES_ROOTS, parseFilesRoot, SendStartSchema, UploadStartSchema,
  type ArchiveFormat, type FilesErrorKind, type FilesRootId,
} from "@/lib/contracts/files"
import { isDomainError } from "@/server/errors"
import type { Logger } from "@/server/log"
import { normalizeIp } from "@/server/request-meta"
import type { AuditService, AuthenticatedSession, AuthUser } from "@/server/runtime/types"
import type { FilesCore } from "./core"
import { filesErrorKind } from "./paths"
import { sessionIdOf, type CopyService, type CopyViewer } from "./copy/service"
import type { ExportService } from "./export/service"
import type { SendService } from "./send/service"
import { tarStream } from "./tar"
import { zipStream } from "./zip"

export interface FilesHttpDeps {
  /** One core per root (null: that root is disabled). */
  cores: Record<FilesRootId, FilesCore | null>
  /** Labels of the roots for messages («tftp», the second folder's name); the id when missing. */
  rootLabels?: Partial<Record<FilesRootId, string>>
  /** «Enviar a equipo» (null: not available in this server, 404). */
  send?: SendService | null
  /** «Copiar a una carpeta del servidor» (administrators). */
  copy?: CopyService | null
  /** «Descargas» (the profile's download script). */
  exports?: ExportService | null
  enabled: boolean
  log: Logger
  audit: AuditService
  authenticate(req: IncomingMessage): Promise<AuthenticatedSession | null>
}

const STATUS: Record<FilesErrorKind, number> = {
  UNAUTHENTICATED: 401, PASSWORD_CHANGE_REQUIRED: 403, FORBIDDEN: 403, DISABLED: 404, NOT_FOUND: 404, INVALID: 400,
  EXISTS: 409, OFFSET: 409, BUSY: 409, TOO_LARGE: 413, NO_SPACE: 507, UNAVAILABLE: 503, RANGE: 416, INTERNAL: 500,
}
const MESSAGES: Partial<Record<FilesErrorKind, string>> = {
  UNAUTHENTICATED: "Tu sesión ha caducado. Vuelve a iniciar sesión.",
  PASSWORD_CHANGE_REQUIRED: "Debes cambiar tu contraseña antes de continuar.",
  DISABLED: "Archivos está desactivado en este servidor.",
}
const BASE_HEADERS = { "cache-control": "no-store", "x-content-type-options": "nosniff", "x-frame-options": "DENY", "referrer-policy": "same-origin" }
const JSON_BODY_MAX = 16 * 1024

class HttpError extends Error {
  constructor(readonly kind: FilesErrorKind, message?: string, readonly extra: Record<string, unknown> = {}) {
    super(message ?? MESSAGES[kind] ?? kind)
  }
}

/** RFC 5987 ext-value (encodeURIComponent leaves ' ( ) * ! as they are). */
const rfc5987 = (s: string) => encodeURIComponent(s).replace(/['()*!]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)
/** ASCII fallback keeping case and dots: accents stripped, anything else → "_". */
export function asciiName(name: string): string {
  const s = name.normalize("NFD").replace(/\p{M}/gu, "").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._]+/, "")
  return s || "archivo"
}
export function contentDisposition(name: string): string {
  return `attachment; filename="${asciiName(name)}"; filename*=UTF-8''${rfc5987(name)}`
}

export type ByteRange = { start: number; end: number } | "unsatisfiable" | null

/** One `bytes=` range (a list of several ranges is served whole, as RFC 9110 allows). null = no (usable) Range. */
export function parseRange(header: string | undefined, size: number): ByteRange {
  if (!header) return null
  const m = /^bytes=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header.trim())
  if (!m) return header.includes(",") || !/^bytes=/i.test(header.trim()) ? null : "unsatisfiable"
  const [, a, b] = m
  if (a === "" && b === "") return "unsatisfiable"
  if (a === "") {
    const n = Number(b)
    if (n === 0) return "unsatisfiable"
    return size === 0 ? "unsatisfiable" : { start: Math.max(0, size - n), end: size - 1 }
  }
  const start = Number(a)
  const end = b === "" ? size - 1 : Math.min(Number(b), size - 1)
  if (!Number.isSafeInteger(start) || start >= size || end < start) return "unsatisfiable"
  return { start, end }
}

export function etagOf(size: number, mtime: Date): string {
  return `W/"${size.toString(16)}-${Math.floor(mtime.getTime()).toString(16)}"`
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  if (res.headersSent) {
    res.destroy()
    return
  }
  const text = JSON.stringify(body)
  res.writeHead(status, { ...BASE_HEADERS, "content-type": "application/json; charset=utf-8", "content-length": String(Buffer.byteLength(text)), ...extra })
  res.end(text)
}

/** Reads (and discards) what is left of a request body, so the response is not lost to a TCP reset. */
function drain(req: IncomingMessage, max = FILES_CHUNK_MAX_BYTES + 1024 * 1024): Promise<boolean> {
  return new Promise((resolve) => {
    if (req.readableEnded || req.complete) return resolve(true)
    let n = 0
    const done = (ok: boolean) => {
      req.off("data", onData)
      req.off("end", onEnd)
      req.off("error", onErr)
      req.off("close", onClose)
      resolve(ok)
    }
    const onData = (c: Buffer) => {
      n += c.length
      if (n > max) done(false)
    }
    const onEnd = () => done(true)
    const onErr = () => done(false)
    const onClose = () => done(req.complete)
    req.on("data", onData)
    req.on("end", onEnd)
    req.on("error", onErr)
    req.on("close", onClose)
    req.resume()
  })
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let n = 0
  for await (const c of req as AsyncIterable<Buffer>) {
    n += c.length
    if (n > JSON_BODY_MAX) throw new HttpError("INVALID", "Petición demasiado grande.")
    chunks.push(c)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown
  } catch {
    throw new HttpError("INVALID", "Petición no válida.")
  }
}

/**
 * The request handler for FILES_API paths. Returns false for any other path (Next serves it). Never throws: every
 * failure becomes a JSON error `{ error, message }` with a Spanish message.
 */
export function createFilesHttp(deps: FilesHttpDeps): (req: IncomingMessage, res: ServerResponse) => boolean {
  const log = deps.log.child("files")

  async function session(req: IncomingMessage): Promise<AuthenticatedSession> {
    const s = await deps.authenticate(req)
    if (!s) throw new HttpError("UNAUTHENTICATED")
    if (s.user.mustChangePassword) throw new HttpError("PASSWORD_CHANGE_REQUIRED")
    return s
  }
  async function user(req: IncomingMessage): Promise<AuthUser> {
    return (await session(req)).user
  }
  const ipOf = (req: IncomingMessage) => normalizeIp(req.socket.remoteAddress ?? "") || null

  /** The core of a root named by the client ("tftp" when absent); unknown → 400, disabled → 404. */
  function coreOf(raw: unknown): FilesCore {
    const id = parseFilesRoot(raw)
    if (!id) throw new HttpError("INVALID", "Carpeta no válida.")
    const c = deps.cores[id]
    if (!c) throw new HttpError("NOT_FOUND", `La carpeta ${(deps.rootLabels?.[id] ?? id)} no está disponible en este servidor.`)
    return c
  }
  /** The core holding an upload session (chunk and cancel requests only carry the id). */
  function coreWithSession(id: string): FilesCore {
    for (const r of FILES_ROOTS) {
      const c = deps.cores[r]
      if (c?.hasSession(id)) return c
    }
    return coreOf("tftp")
  }

  async function list(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    await user(req)
    const core = coreOf(url.searchParams.get("root"))
    const listing = await core.list(url.searchParams.get("path") ?? "")
    sendJson(res, 200, listing)
  }

  /** A client that stops reading (the socket idle for 2 min) is dropped: no descriptor held forever. */
  const idleLimit = (res: ServerResponse) => res.setTimeout(120_000, () => res.destroy())

  async function download(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const u = await user(req)
    const core = coreOf(url.searchParams.get("root"))
    idleLimit(res)
    const src = await core.openDownload(url.searchParams.get("path") ?? "")
    let closed = false
    const close = () => {
      if (closed) return
      closed = true
      void src.handle.close().catch(() => undefined)
    }
    try {
      const etag = etagOf(src.size, src.mtime)
      const lastModified = src.mtime.toUTCString()
      let range = parseRange(req.headers.range, src.size)
      const ifRange = req.headers["if-range"]
      if (range && ifRange && ifRange !== etag && ifRange !== lastModified) range = null
      const headers: Record<string, string> = {
        ...BASE_HEADERS,
        "content-type": "application/octet-stream",
        "content-disposition": contentDisposition(src.name),
        "content-security-policy": "default-src 'none'; sandbox",
        "accept-ranges": "bytes",
        etag,
        "last-modified": lastModified,
      }
      if (range === "unsatisfiable") {
        close()
        res.writeHead(416, { ...headers, "content-range": `bytes */${src.size}`, "content-length": "0" })
        res.end()
        return
      }
      const start = range ? range.start : 0
      const end = range ? range.end : src.size - 1
      const length = src.size === 0 ? 0 : end - start + 1
      if (range) headers["content-range"] = `bytes ${start}-${end}/${src.size}`
      headers["content-length"] = String(length)
      if (req.method !== "HEAD" && start === 0) {
        deps.audit.record({
          actor: { kind: "user", id: u.id, name: u.username, ip: ipOf(req) }, action: "files.download",
          target: { type: "file", id: null, name: src.path }, detail: { root: core.rootId, path: src.path, sizeBytes: src.size, ...(range ? { range: `${start}-${end}` } : {}) },
        })
      }
      res.writeHead(range ? 206 : 200, headers)
      if (req.method === "HEAD" || length === 0) {
        close()
        res.end()
        return
      }
      const stream = src.handle.createReadStream({ start, end, highWaterMark: 256 * 1024, autoClose: true })
      closed = true // the stream owns the handle now
      await pipeline(stream, res).catch(() => undefined) // client gone: the stream is destroyed, the handle closed
    } finally {
      close()
    }
  }

  /**
   * A folder or a selection as one archive, built while it is sent: ZIP (stored, ZIP64 when needed) or tar.gz (pax
   * headers, gzip on the fly). If the client goes away, the pipeline stops and closes the file being read.
   */
  async function archive(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const u = await user(req)
    const core = coreOf(url.searchParams.get("root"))
    const format = (url.searchParams.get("format") ?? "zip") as ArchiveFormat
    if (!(ARCHIVE_FORMATS as readonly string[]).includes(format)) throw new HttpError("INVALID", "Formato no válido: usa zip o tar.gz.")
    const dir = url.searchParams.get("dir") ?? ""
    const names = url.searchParams.getAll("name")
    if (names.length > 1000) throw new HttpError("INVALID", "Demasiados elementos: descarga la carpeta entera.")
    const src = await core.archiveSource(dir, names)
    idleLimit(res)
    const fileName = `${src.baseName}.${format}`
    const actor = { kind: "user" as const, id: u.id, name: u.username, ip: ipOf(req) }
    const target = { type: "file" as const, id: null, name: names.length === 1 ? (dir ? `${dir}/${names[0]}` : names[0]) : dir || "/" }
    if (req.method !== "HEAD") deps.audit.record({ actor, action: "files.download", target, detail: { root: core.rootId, dir: dir || "/", names: names.slice(0, 100), format } })
    res.writeHead(200, {
      ...BASE_HEADERS,
      "content-type": format === "zip" ? "application/zip" : "application/gzip",
      "content-disposition": contentDisposition(fileName),
      "content-security-policy": "default-src 'none'; sandbox",
    })
    if (req.method === "HEAD") {
      res.end()
      return
    }
    const body = Readable.from(format === "zip" ? zipStream(src.entries) : tarStream(src.entries), { objectMode: false })
    const stages = format === "zip" ? [body, res] as const : [body, zlib.createGzip({ level: 6 }), res] as const
    try {
      await pipeline(...(stages as unknown as [Readable, NodeJS.WritableStream]))
    } catch (err) {
      log.debug("Descarga de archivo comprimido interrumpida", { error: err instanceof Error ? err.message : String(err) })
      res.destroy()
      return
    }
    if (src.skipped.length) {
      log.info("Descarga con elementos omitidos", { carpeta: dir || "/", omitidos: src.skipped.length })
    }
  }

  async function uploadStart(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const u = await user(req)
    const parsed = UploadStartSchema.safeParse(await readJson(req))
    if (!parsed.success) throw new HttpError("INVALID", "Petición no válida.")
    const { root, ...input } = parsed.data
    const r = await coreOf(root).uploadStart(input, { id: u.id, name: u.name, username: u.username, ip: ipOf(req), isAdmin: u.isAdmin })
    sendJson(res, 201, r)
  }

  async function uploadChunk(req: IncomingMessage, res: ServerResponse, id: string, url: URL): Promise<void> {
    let u: AuthUser
    try {
      u = await user(req)
    } catch (e) {
      await drain(req)
      throw e
    }
    const offset = Number(url.searchParams.get("offset") ?? "")
    const declared = req.headers["content-length"] === undefined ? null : Number(req.headers["content-length"])
    if (!Number.isSafeInteger(offset) || offset < 0 || (declared !== null && (!Number.isSafeInteger(declared) || declared > FILES_CHUNK_MAX_BYTES))) {
      const ok = await drain(req)
      throw new HttpError("INVALID", "Fragmento no válido.", ok ? {} : { close: true })
    }
    try {
      const r = await coreWithSession(id).uploadChunk(id, u.id, offset, req)
      sendJson(res, 200, r)
    } catch (e) {
      // Errors before or while reading the body: read the rest so the client receives the answer.
      const ok = await drain(req)
      if (!ok) throw Object.assign(e as object, { closeConnection: true })
      throw e
    }
  }

  async function uploadCancel(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    const u = await user(req)
    await coreWithSession(id).uploadCancel(id, u.id)
    res.writeHead(204, BASE_HEADERS)
    res.end()
  }

  // --- «Enviar a equipo» -----------------------------------------------------------------------------------------
  function sender(): SendService {
    if (!deps.send) throw new HttpError("NOT_FOUND", "No disponible en este servidor.")
    return deps.send
  }

  async function sendRoute(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const m = req.method ?? "GET"
    const p = url.pathname
    if (p === FILES_API.sendTargets && m === "GET") {
      const u = await user(req)
      sendJson(res, 200, { targets: await sender().targets(u) })
      return true
    }
    if (p === FILES_API.send) {
      if (m === "GET") {
        const u = await user(req)
        sendJson(res, 200, { jobs: sender().jobs(u.id) })
        return true
      }
      if (m === "POST") {
        const u = await user(req)
        // The body carries the SSH password: parsed here, never logged nor echoed back.
        const parsed = SendStartSchema.safeParse(await readJson(req))
        if (!parsed.success) {
          const issue = parsed.error.issues[0]
          const field = issue?.path[0]
          throw new HttpError("INVALID", field === "username" && issue ? issue.message : "Petición no válida.", typeof field === "string" ? { field } : {})
        }
        if (!deps.cores[parsed.data.root]) throw new HttpError("NOT_FOUND", `La carpeta ${(deps.rootLabels?.[parsed.data.root] ?? parsed.data.root)} no está disponible en este servidor.`)
        sendJson(res, 202, await sender().start(u, ipOf(req), parsed.data))
        return true
      }
      if (m === "DELETE") {
        const u = await user(req)
        sender().clearFinished(u.id)
        res.writeHead(204, BASE_HEADERS)
        res.end()
        return true
      }
    }
    const prof = /^\/api\/files\/send\/profile\/([A-Za-z0-9_-]{1,64})$/.exec(p)
    if (prof && m === "DELETE") {
      const u = await user(req)
      await sender().forget(u, ipOf(req), prof[1])
      res.writeHead(204, BASE_HEADERS)
      res.end()
      return true
    }
    const job = /^\/api\/files\/send\/([0-9a-f]{32})$/.exec(p)
    if (job && m === "DELETE") {
      const u = await user(req)
      if (!sender().cancel(u.id, job[1])) throw new HttpError("NOT_FOUND", "Ese envío ya no existe.")
      res.writeHead(204, BASE_HEADERS)
      res.end()
      return true
    }
    return false
  }

  // --- «Copiar a una carpeta del servidor» (administrators; the service checks it again) ----------------------------
  function copier(): CopyService {
    if (!deps.copy) throw new HttpError("NOT_FOUND", "No disponible en este servidor.")
    return deps.copy
  }
  /** Bodies with the sudo password: parsed here, never logged nor echoed back; the raw buffers are zeroed. */
  async function readSecretJson(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = []
    let n = 0
    try {
      for await (const c of req as AsyncIterable<Buffer>) {
        n += c.length
        if (n > JSON_BODY_MAX) throw new HttpError("INVALID", "Petición demasiado grande.")
        chunks.push(c)
      }
      const all = Buffer.concat(chunks)
      try {
        return JSON.parse(all.toString("utf8")) as unknown
      } catch {
        throw new HttpError("INVALID", "Petición no válida.")
      } finally {
        all.fill(0)
      }
    } finally {
      for (const c of chunks) c.fill(0)
    }
  }
  function invalidBody(error: { issues: Array<{ path: PropertyKey[] }> }): HttpError {
    const field = error.issues[0]?.path[0]
    return new HttpError("INVALID", field === "password" ? "Escribe la contraseña." : "Petición no válida.", typeof field === "string" ? { field } : {})
  }

  async function viewer(req: IncomingMessage): Promise<CopyViewer> {
    const s = await session(req)
    return { user: s.user, ip: ipOf(req), sid: sessionIdOf(s) }
  }

  async function copyRoute(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const m = req.method ?? "GET"
    const p = url.pathname
    if (p === FILES_API.copyInfo && m === "GET") {
      sendJson(res, 200, await copier().info(await viewer(req)))
      return true
    }
    if (p === FILES_API.copyBrowse && m === "GET") {
      const v = await viewer(req)
      sendJson(res, 200, await copier().browse(v, url.searchParams.get("path") ?? "/", url.searchParams.get("hidden") === "1"))
      return true
    }
    if (p === FILES_API.copyBrowse && m === "POST") {
      const v = await viewer(req)
      const parsed = CopyBrowseRootSchema.safeParse(await readSecretJson(req))
      if (!parsed.success) throw invalidBody(parsed.error)
      sendJson(res, 200, await copier().browseAsRoot(v, parsed.data.path, parsed.data.hidden, parsed.data.password))
      return true
    }
    if (p === FILES_API.copyMkdir && m === "POST") {
      const v = await viewer(req)
      const parsed = CopyMkdirSchema.safeParse(await readSecretJson(req))
      if (!parsed.success) throw invalidBody(parsed.error)
      sendJson(res, 201, await copier().mkdir(v, parsed.data))
      return true
    }
    if (p === FILES_API.copyMount && m === "POST") {
      const v = await viewer(req)
      const parsed = CopyMountSchema.safeParse(await readSecretJson(req))
      if (!parsed.success) throw invalidBody(parsed.error)
      sendJson(res, 200, await copier().mount(v, parsed.data))
      return true
    }
    if (p === FILES_API.copyUnmount && m === "POST") {
      const v = await viewer(req)
      const parsed = CopyUnmountSchema.safeParse(await readSecretJson(req))
      if (!parsed.success) throw invalidBody(parsed.error)
      sendJson(res, 200, await copier().unmount(v, parsed.data))
      return true
    }
    if (p === FILES_API.copyElevation && m === "DELETE") {
      await copier().forget(await viewer(req))
      res.writeHead(204, BASE_HEADERS)
      res.end()
      return true
    }
    if (p === FILES_API.copy) {
      if (m === "GET") {
        const u = await user(req)
        sendJson(res, 200, { jobs: u.isAdmin ? copier().jobs(u.id) : [] })
        return true
      }
      if (m === "POST") {
        const v = await viewer(req)
        const parsed = CopyStartSchema.safeParse(await readSecretJson(req))
        if (!parsed.success) throw invalidBody(parsed.error)
        if (!deps.cores[parsed.data.root]) throw new HttpError("NOT_FOUND", `La carpeta ${(deps.rootLabels?.[parsed.data.root] ?? parsed.data.root)} no está disponible en este servidor.`)
        sendJson(res, 202, await copier().start(v, parsed.data))
        return true
      }
      if (m === "DELETE") {
        const u = await user(req)
        copier().clearFinished(u.id)
        res.writeHead(204, BASE_HEADERS)
        res.end()
        return true
      }
    }
    const job = /^\/api\/files\/copy\/([0-9a-f]{32})$/.exec(p)
    if (job && m === "DELETE") {
      const u = await user(req)
      if (!copier().cancel(u.id, job[1])) throw new HttpError("NOT_FOUND", "Esa copia ya no existe.")
      res.writeHead(204, BASE_HEADERS)
      res.end()
      return true
    }
    return false
  }

  // --- «Descargas» (the profile's download script; any signed-in user, audited) ------------------------------------
  function exporter(): ExportService {
    if (!deps.exports) throw new HttpError("NOT_FOUND", "No disponible en este servidor.")
    return deps.exports
  }

  async function exportRoute(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const m = req.method ?? "GET"
    const p = url.pathname
    if (p === FILES_API.exports) {
      if (m === "GET") {
        const u = await user(req)
        sendJson(res, 200, { jobs: exporter().jobs(u), info: await exporter().info() })
        return true
      }
      if (m === "POST") {
        const u = await user(req)
        const parsed = ExportStartSchema.safeParse(await readJson(req))
        if (!parsed.success) {
          const issue = parsed.error.issues[0]
          const field = issue?.path[0]
          const msg = (field === "app" || field === "version") && issue ? `${field === "app" ? "Aplicación" : "Versión"}: ${issue.message}` : "Petición no válida."
          throw new HttpError("INVALID", msg, typeof field === "string" ? { field } : {})
        }
        sendJson(res, 202, { job: await exporter().start(u, ipOf(req), parsed.data) })
        return true
      }
    }
    const job = /^\/api\/files\/export\/([0-9a-f]{32})$/.exec(p)
    if (job && m === "DELETE") {
      const u = await user(req)
      if (!exporter().cancel(u, ipOf(req), job[1])) throw new HttpError("NOT_FOUND", "Esa descarga ya no existe.")
      res.writeHead(204, BASE_HEADERS)
      res.end()
      return true
    }
    return false
  }

  async function route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (!deps.enabled) {
      await drain(req)
      throw new HttpError("DISABLED")
    }
    const m = req.method ?? "GET"
    const p = url.pathname
    if (p === FILES_API.list && (m === "GET" || m === "HEAD")) return list(req, res, url)
    if (p === FILES_API.download && (m === "GET" || m === "HEAD")) return download(req, res, url)
    if (p === FILES_API.archive && (m === "GET" || m === "HEAD")) return archive(req, res, url)
    if (p === FILES_API.upload && m === "POST") return uploadStart(req, res)
    const up = /^\/api\/files\/upload\/([0-9a-f]{32})$/.exec(p)
    if (up && m === "PUT") return uploadChunk(req, res, up[1], url)
    if (up && m === "DELETE") return uploadCancel(req, res, up[1])
    if (p === FILES_API.send || p.startsWith(`${FILES_API.send}/`)) {
      if (await sendRoute(req, res, url)) return
    }
    if (p === FILES_API.copy || p.startsWith(`${FILES_API.copy}/`)) {
      if (await copyRoute(req, res, url)) return
    }
    if (p === FILES_API.exports || p.startsWith(`${FILES_API.exports}/`)) {
      if (await exportRoute(req, res, url)) return
    }
    await drain(req)
    throw new HttpError("NOT_FOUND", "No existe.")
  }

  function fail(res: ServerResponse, e: unknown): void {
    const close = typeof e === "object" && e !== null && ((e as { closeConnection?: unknown }).closeConnection === true || (e instanceof HttpError && e.extra.close === true))
    const extraHeaders: Record<string, string> = close ? { connection: "close" } : {}
    if (e instanceof HttpError) {
      sendJson(res, STATUS[e.kind], { error: e.kind, message: e.message, ...(typeof e.extra.field === "string" ? { field: e.extra.field } : {}) }, extraHeaders)
      return
    }
    const kind = filesErrorKind(e)
    if (kind && isDomainError(e)) {
      const { files: _files, ...rest } = e.details ?? {}
      void _files
      sendJson(res, STATUS[kind], { error: kind, message: e.message, ...rest }, extraHeaders)
      return
    }
    const ref = crypto.randomBytes(4).toString("hex")
    log.error("Error interno en Archivos", { ref, err: e })
    sendJson(res, 500, { error: "INTERNAL", message: `Error interno (ref ${ref}). Inténtalo de nuevo y, si se repite, avisa al administrador.` }, extraHeaders)
  }

  return (req, res) => {
    const raw = req.url ?? "/"
    if (!raw.startsWith("/api/files/") && raw !== "/api/files") return false
    let url: URL
    try {
      url = new URL(raw, "http://localhost")
    } catch {
      sendJson(res, 400, { error: "INVALID", message: "Petición no válida." })
      return true
    }
    route(req, res, url).catch((e: unknown) => {
      try {
        fail(res, e)
      } catch {
        res.destroy()
      }
    })
    return true
  }
}
