// Root helper (relay-manager-rootcopy): the connection handler. One request per connection (protocol.ts). Every
// request but "ping" and "revoke" authenticates first: the configured sudo user's password (auth.ts) or an elevation
// token this helper issued (token.ts: HMAC, 5 min, bound to the service's login session and web user). Then it
// re-validates the destination on its own (normalised absolute path → realpath → deny-list and RM_COPY_ROOT_PATHS →
// opened component by component without following links) and only then writes, through the same code the service uses
// (safe-dest.ts). For a copy the bytes come from the connection (the service reads its own folder): this process never
// opens a source path, and "list" only reads directory entries and their metadata (never a file's contents). Mount and
// unmount are relayed to the mount helper (relay-manager-rootmount, root:root socket), which checks them again: this
// unit keeps its sandbox and gains no privilege for them. It never logs or keeps the password.
import fs from "node:fs"
import net from "node:net"
import util from "node:util"
import {
  HEADER_MAX_BYTES, LineReader, parseRequest, type HelperErrorCode, type HelperMsg, type HelperRequest,
  type IssuedToken, type MountMessage, type MountRequest, type PingResult,
} from "@/server/files/copy/protocol"
import { aliasesOf, parseMountinfo } from "@/server/files/copy/mounts"
import {
  buildPolicy, DEFAULT_ROOT_WRITE_PATHS, DEFAULT_SUDO_GROUPS, denyReasonWithAliases, inRoots, normalizeAbs, parsePathList, rootWriteReason,
  within, type CopyPolicy,
} from "@/server/files/copy/policy"
import {
  canWrite, CopyError, listEntries, listFolders, mkdirIn, openDestDir, precheck, spaceOf, writeIntoDir, type DestDir,
} from "@/server/files/copy/safe-dest"
import { accountStatus, readAccountTexts, verifyPassword, type AccountFiles, type AttemptLimiter, type Crypter } from "./auth"
import { TokenStore } from "./token"

/** Never listed, not even as root: pseudo filesystems and the helpers' own state (keys, attempts, mounts). */
export const LIST_DENY: readonly string[] = [
  "/proc", "/sys", "/dev", "/run/relay-manager-rootcopy", "/run/relay-manager-rootmount", "/var/lib/relay-manager-rootcopy",
  "/var/lib/relay-manager-rootmount",
]

export interface HelperConfig {
  enabled: boolean
  sudoUser: string
  sudoGroups: string[]
  /** Where root may write (RM_COPY_ROOT_PATHS). The systemd unit's ReadWritePaths= is the hard limit. */
  writePaths: string[]
  policy: CopyPolicy
}

/** The helper's configuration file (rootcopy.env, written by install.sh). Missing → disabled. */
export function loadHelperConfig(text: string | null): HelperConfig {
  const v = text ? (util.parseEnv(text) as Record<string, string | undefined>) : {}
  const get = (k: string) => (v[k] ?? "").trim()
  const list = (k: string, def: readonly string[]) => (get(k) ? parsePathList(get(k), k) : [...def])
  const enabled = text !== null && get("RM_COPY_ENABLED") !== "0" && get("RM_COPY_ENABLED") !== "false"
  const writePaths = list("RM_COPY_ROOT_PATHS", DEFAULT_ROOT_WRITE_PATHS)
  // Root never writes "anywhere": "/" would make the deny-list the only barrier (the unit's ReadWritePaths= too).
  if (writePaths.includes("/")) throw new Error("RM_COPY_ROOT_PATHS no puede incluir «/»: indica carpetas concretas")
  return {
    enabled,
    sudoUser: get("RM_SUDO_USER") || "root",
    sudoGroups: get("RM_COPY_SUDO_GROUPS") ? get("RM_COPY_SUDO_GROUPS").split(",").map((s) => s.trim()).filter(Boolean) : [...DEFAULT_SUDO_GROUPS],
    writePaths,
    policy: buildPolicy(list("RM_COPY_ROOTS", ["/"]), list("RM_COPY_DENY", []), []),
  }
}

export interface RootCopyServerOptions {
  config: HelperConfig
  files: AccountFiles
  crypter: Crypter
  limiter: AttemptLimiter
  version: string
  /** Pause after a wrong password (slows down guessing). */
  failDelayMs?: number
  maxConcurrent?: number
  headerTimeoutMs?: number
  /** Inactivity while copying (no bytes from the client). */
  idleTimeoutMs?: number
  log?: (msg: string) => void
  /** Elevation tokens (default: an in-memory key; main.ts passes the state directory's). */
  tokens?: TokenStore
  /** The mount helper's socket (relay-manager-rootmount); null: mounting is not available. */
  mountSocket?: string | null
  /** Extra folders never listed (the state directory in tests). */
  listDeny?: readonly string[]
}

interface Conn {
  sock: net.Socket
  it: AsyncIterator<Buffer>
  /** Bytes already read past the header. */
  rest: Buffer | null
}

function send(sock: net.Socket, m: HelperMsg): void {
  if (!sock.destroyed && sock.writable) sock.write(`${JSON.stringify(m)}\n`)
}

/** Reads the header line; the bytes after it stay in `rest`. */
async function readHeader(sock: net.Socket, timeoutMs: number): Promise<Conn & { line: string }> {
  const it = (sock as unknown as AsyncIterable<Buffer>)[Symbol.asyncIterator]()
  const reader = new LineReader(HEADER_MAX_BYTES)
  const chunks: Buffer[] = []
  let total = 0
  const timer = setTimeout(() => sock.destroy(), timeoutMs)
  try {
    for (;;) {
      const r = await it.next()
      if (r.done) throw new CopyError("PROTOCOL", "Conexión cerrada antes de la petición.")
      const c = r.value
      const nl = c.indexOf(0x0a)
      if (nl < 0) {
        total += c.length
        if (total > HEADER_MAX_BYTES) throw new CopyError("PROTOCOL", "Petición demasiado grande.")
        chunks.push(c)
        continue
      }
      chunks.push(c.subarray(0, nl + 1))
      const head = Buffer.concat(chunks)
      const line = reader.push(head)[0] ?? ""
      head.fill(0)
      for (const ch of chunks) ch.fill(0)
      const rest = nl + 1 < c.length ? Buffer.from(c.subarray(nl + 1)) : null
      c.fill(0, 0, nl + 1)
      return { sock, it, rest, line }
    }
  } finally {
    clearTimeout(timer)
  }
}

/** Exactly `size` bytes of the connection (after the "ready" line). */
async function* bodyOf(c: Conn, size: number, idleMs: number): AsyncGenerator<Buffer> {
  let left = size
  if (c.rest) {
    const take = c.rest.subarray(0, Math.min(left, c.rest.length))
    if (c.rest.length > left) throw new CopyError("PROTOCOL", "Se han recibido más datos de los anunciados.")
    left -= take.length
    if (take.length) yield take
    c.rest = null
  }
  while (left > 0) {
    let timer: NodeJS.Timeout | null = null
    const r = await Promise.race([
      c.it.next(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new CopyError("CANCELED", "El servicio ha dejado de enviar datos: copia cancelada.")), idleMs) }),
    ]).finally(() => { if (timer) clearTimeout(timer) })
    if (r.done) return // short: writeIntoDir reports "interrumpida"
    const chunk = r.value
    if (chunk.length > left) throw new CopyError("PROTOCOL", "Se han recibido más datos de los anunciados.")
    left -= chunk.length
    yield chunk
  }
}

/** One request to the mount helper; its single answer line. */
export function mountCall(sockPath: string, req: MountRequest, timeoutMs: number): Promise<MountMessage> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ path: sockPath })
    const reader = new LineReader(64 * 1024)
    let done = false
    const finish = (e: Error | null, m?: MountMessage) => {
      if (done) return
      done = true
      clearTimeout(timer)
      sock.destroy()
      if (e) reject(e)
      else resolve(m as MountMessage)
    }
    const timer = setTimeout(() => finish(new CopyError("IO", "El ayudante de montaje no contesta.")), timeoutMs)
    sock.on("connect", () => sock.write(`${JSON.stringify(req)}\n`))
    sock.on("data", (c: Buffer) => {
      let lines: string[]
      try {
        lines = reader.push(c)
      } catch {
        return finish(new CopyError("IO", "Respuesta no válida del ayudante de montaje."))
      }
      if (!lines.length) return
      try {
        finish(null, JSON.parse(lines[0]) as MountMessage)
      } catch {
        finish(new CopyError("IO", "Respuesta no válida del ayudante de montaje."))
      }
    })
    sock.on("error", (e: NodeJS.ErrnoException) => {
      if (["ENOENT", "ECONNREFUSED", "EACCES", "ENOTSOCK", "ECONNRESET"].includes(e.code ?? "")) {
        finish(new CopyError("NO_MOUNT", "El ayudante de montaje no responde (relay-manager-rootmount.socket): sudo systemctl enable --now relay-manager-rootmount.socket"))
      } else finish(new CopyError("IO", `Error con el ayudante de montaje: ${e.message}`))
    })
    sock.on("close", () => finish(new CopyError("IO", "El ayudante de montaje ha cerrado la conexión sin responder.")))
  })
}

export function createRootCopyServer(o: RootCopyServerOptions): net.Server & { active(): number } {
  const cfg = o.config
  const tokens = o.tokens ?? new TokenStore({ keyFile: null, revokedFile: null })
  const mountSocket = o.mountSocket === undefined ? null : o.mountSocket
  const listDeny = [...LIST_DENY, ...(o.listDeny ?? [])]
  const failDelay = o.failDelayMs ?? 1500
  const maxConcurrent = o.maxConcurrent ?? 2
  const headerTimeout = o.headerTimeoutMs ?? 10_000
  const idleMs = o.idleTimeoutMs ?? 60_000
  const log = o.log ?? (() => undefined)
  let busy = 0
  /** Password checks one at a time: concurrent wrong attempts cannot overshoot the limit (read-modify-write). */
  let authChain: Promise<unknown> = Promise.resolve()
  const serialized = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = authChain.then(fn, fn)
    authChain = run.catch(() => undefined)
    return run
  }

  async function mountAvailability(): Promise<{ available: boolean; problem: string | null }> {
    if (!mountSocket) return { available: false, problem: "No hay ayudante de montaje en esta instalación." }
    try {
      const r = await mountCall(mountSocket, { v: 1, op: "ping" }, 5000)
      return r.type === "result" ? { available: true, problem: null } : { available: false, problem: r.message }
    } catch (e) {
      return { available: false, problem: e instanceof Error ? e.message : String(e) }
    }
  }

  async function ping(): Promise<PingResult> {
    const st = accountStatus(cfg.sudoUser, cfg.sudoGroups, await readAccountTexts(o.files))
    const m = await o.crypter.method()
    return {
      type: "result", op: "ping", version: o.version, enabled: cfg.enabled, mount: await mountAvailability(), user: cfg.sudoUser, account: st.state,
      accountMessage: st.message, method: m.name, methodError: m.error, writePaths: cfg.writePaths,
    }
  }

  /** A folder to LIST (read-only): inside RM_COPY_ROOTS, not a pseudo filesystem nor the helpers' state; no links. */
  async function listable(raw: string): Promise<DestDir> {
    const p = normalizeAbs(raw)
    if (!p) throw new CopyError("INVALID", "Ruta no válida.")
    let real: string
    try {
      real = await fs.promises.realpath(p)
    } catch {
      throw new CopyError("NOT_FOUND", `No existe «${p}» (¿se ha quitado el disco?).`)
    }
    if (!inRoots(real, cfg.policy)) throw new CopyError("DENIED", `Fuera de las carpetas permitidas (${cfg.policy.roots.join(", ")}; RM_COPY_ROOTS).`)
    const aliases = await fs.promises.readFile("/proc/self/mountinfo", "utf8").then((t) => aliasesOf(real, parseMountinfo(t)), () => [] as string[])
    const hit = [real, ...aliases].find((x) => listDeny.some((d) => within(x, d)))
    if (hit) throw new CopyError("DENIED", `«${real}» no se puede ver desde aquí (carpeta del sistema o de los ayudantes).`)
    const dir = await openDestDir(real)
    if (listDeny.some((d) => within(dir.real, d))) {
      await dir.close()
      throw new CopyError("DENIED", `«${dir.real}» no se puede ver desde aquí.`)
    }
    return dir
  }

  async function relayMount(req: MountRequest): Promise<Extract<MountMessage, { type: "result" }>> {
    if (!mountSocket) throw new CopyError("NO_MOUNT", "No hay ayudante de montaje en esta instalación.")
    const r = await mountCall(mountSocket, req, 11 * 60_000)
    if (r.type === "error") throw new CopyError(r.code, r.message)
    return r
  }

  /** The destination, re-validated here: normalised, real path, deny-list, RM_COPY_ROOT_PATHS, opened safely. */
  async function destination(raw: string): Promise<DestDir> {
    const p = normalizeAbs(raw)
    if (!p) throw new CopyError("INVALID", "Ruta de destino no válida.")
    let real: string
    try {
      real = await fs.promises.realpath(p)
    } catch {
      throw new CopyError("NOT_FOUND", "La carpeta de destino no existe (¿se ha quitado el disco?).")
    }
    // The deny-list also on the folder's other names: a system folder bind-mounted under /mnt is still that folder.
    const aliases = await fs.promises.readFile("/proc/self/mountinfo", "utf8").then((t) => aliasesOf(real, parseMountinfo(t)), () => [] as string[])
    const why = denyReasonWithAliases(real, aliases, cfg.policy) ?? rootWriteReason(real, cfg.writePaths)
    if (why) throw new CopyError("DENIED", why)
    const dir = await openDestDir(real)
    // Re-checked on what was actually opened (equal to `real` by construction; belt and braces).
    const again = denyReasonWithAliases(dir.real, aliases, cfg.policy) ?? rootWriteReason(dir.real, cfg.writePaths)
    if (again) {
      await dir.close()
      throw new CopyError("DENIED", again)
    }
    return dir
  }

  async function handle(sock: net.Socket): Promise<void> {
    let conn: (Conn & { line: string }) | null = null
    let req: HelperRequest | null = null
    let counted = false
    try {
      conn = await readHeader(sock, headerTimeout)
      const parsed = parseRequest(conn.line)
      conn.line = ""
      if (!parsed.ok) throw new CopyError("PROTOCOL", parsed.message)
      req = parsed.req
      if (req.op === "ping") {
        send(sock, await ping())
        return
      }
      if (req.op === "revoke") {
        // Possession of a valid token is the authorisation: nothing else can be done with it here.
        const ok = tokens.revoke(req.token)
        log(ok ? "permisos olvidados (token revocado)" : "revocación de un permiso que ya no valía")
        send(sock, { type: "result", op: "revoke" })
        return
      }
      if (!cfg.enabled) throw new CopyError("DISABLED", "La copia como administrador está desactivada en este servidor (RM_COPY_ENABLED=0).")
      if (busy >= maxConcurrent) throw new CopyError("BUSY", "Hay otras copias como administrador en curso: inténtalo en un momento.")
      busy++
      counted = true

      // 1. The password of the configured account (never the client's idea of who it is), or a token issued here.
      let issued: IssuedToken | undefined
      if (req.token !== undefined) {
        const t = tokens.verify(req.token, req.session ? { ...req.session, rootUser: cfg.sudoUser } : undefined)
        if (!t.ok) throw new CopyError("TOKEN", `${t.message} Escribe la contraseña de ${cfg.sudoUser} otra vez.`)
        // The account must still be able to authenticate (not locked, still in a sudo group): a token never outlives it.
        const st = accountStatus(cfg.sudoUser, cfg.sudoGroups, await readAccountTexts(o.files))
        if (st.state !== "ok") throw new CopyError("TOKEN", `${st.message ?? "La cuenta de administrador ya no sirve."} Los permisos se han retirado.`)
      } else {
        const pw = Buffer.from(req.password ?? "", "utf8")
        req.password = ""
        let auth: Awaited<ReturnType<typeof verifyPassword>>
        try {
          auth = await serialized(async () => {
            const r = await verifyPassword({ user: cfg.sudoUser, sudoGroups: cfg.sudoGroups, password: pw, files: o.files, crypter: o.crypter, limiter: o.limiter })
            // The pause after a wrong password is inside the queue: guesses cannot run in parallel either.
            if (!r.ok && r.code !== "ACCOUNT") await new Promise((res) => setTimeout(res, failDelay))
            return r
          })
        } finally {
          pw.fill(0)
        }
        if (!auth.ok) {
          log(`autenticación rechazada (${auth.code}) para ${cfg.sudoUser}`)
          throw new CopyError(auth.code, auth.message)
        }
        if (req.issue && req.session) {
          issued = tokens.issue({ ...req.session, rootUser: cfg.sudoUser })
          log(`permisos de administrador concedidos a una sesión hasta ${new Date(issued.expiresAt).toISOString()}`)
        }
      }
      const withToken = <T extends object>(m: T): T => (issued ? { ...m, token: issued } : m)

      // 2. Mount and unmount: the mount helper decides again.
      if (req.op === "mount") {
        const r = await relayMount({ v: 1, op: "mount", device: req.device })
        log(`montaje pedido: ${req.device}`)
        send(sock, withToken(r) as HelperMsg)
        return
      }
      if (req.op === "unmount") {
        const r = await relayMount({ v: 1, op: "unmount", mountPoint: req.mountPoint })
        send(sock, withToken(r) as HelperMsg)
        return
      }

      // 3. Listing (read-only: entries and metadata).
      if (req.op === "list") {
        const dir = await listable(req.dir)
        try {
          const listed = await listEntries(dir, req.hidden)
          const aliases = await fs.promises.readFile("/proc/self/mountinfo", "utf8").then((t) => aliasesOf(dir.real, parseMountinfo(t)), () => [] as string[])
          const may = !(denyReasonWithAliases(dir.real, aliases, cfg.policy) ?? rootWriteReason(dir.real, cfg.writePaths))
          const space = await spaceOf(dir)
          send(sock, withToken({
            type: "result" as const, op: "list" as const, real: dir.real, entries: listed.entries, truncated: listed.truncated,
            writable: may && (await canWrite(dir)), freeBytes: space?.freeBytes ?? null, totalBytes: space?.totalBytes ?? null,
          }))
        } finally {
          await dir.close()
        }
        return
      }

      // 4. The destination.
      const dir = await destination(req.dir)
      try {
        if (req.op === "probe") {
          const space = await spaceOf(dir)
          const list = req.list ? await listFolders(dir, req.hidden) : null
          const writable = await canWrite(dir)
          send(sock, withToken({
            type: "result" as const, op: "probe" as const, real: dir.real, writable,
            freeBytes: space?.freeBytes ?? null, totalBytes: space?.totalBytes ?? null, folders: list?.folders ?? null, truncated: list?.truncated ?? false,
          }))
          return
        }
        if (req.op === "mkdir") {
          const real = await mkdirIn(dir, req.name, { uid: dir.uid, gid: dir.gid })
          log(`carpeta creada: ${real}`)
          send(sock, withToken({ type: "result" as const, op: "mkdir" as const, real, name: req.name }))
          return
        }
        // copy
        const r = req
        if ((await precheck(dir, r.name, r.conflict)) === "skip") {
          send(sock, withToken({ type: "result" as const, op: "copy" as const, name: null, skipped: true, replaced: false, sha256: null, size: r.size }))
          return
        }
        send(sock, { type: "ready" })
        let last = 0
        const ac = new AbortController()
        const onClose = () => ac.abort()
        sock.once("close", onClose)
        try {
          const res = await writeIntoDir(dir, r.name, r.conflict, {
            size: r.size, source: bodyOf(conn, r.size, idleMs), mode: 0o644, owner: { uid: dir.uid, gid: dir.gid }, signal: ac.signal,
            onProgress: (n) => {
              const t = Date.now()
              if (t - last >= 250 || n === r.size) {
                last = t
                send(sock, { type: "progress", bytes: n })
              }
            },
            onVerifying: () => send(sock, { type: "verifying" }),
          })
          log(`copia ${res.skipped ? "omitida" : "hecha"}: ${dir.real}/${res.name ?? r.name} (${r.size} bytes)`)
          send(sock, withToken({ type: "result" as const, op: "copy" as const, name: res.name, skipped: res.skipped, replaced: res.replaced, sha256: res.sha256, size: r.size }))
        } finally {
          sock.off("close", onClose)
        }
      } finally {
        await dir.close()
      }
    } catch (e) {
      const err = e instanceof CopyError ? e : new CopyError("IO", "Error interno del ayudante de copia.")
      if (!(e instanceof CopyError)) log(`error interno: ${e instanceof Error ? e.message : String(e)}`)
      send(sock, { type: "error", code: err.code as HelperErrorCode, message: err.message })
    } finally {
      if (counted) busy--
      if (req && "password" in req && req.password !== undefined) req.password = ""
      sock.end()
    }
  }

  const server = net.createServer({ allowHalfOpen: false }, (sock) => {
    sock.on("error", () => undefined)
    void handle(sock)
  }) as net.Server & { active(): number }
  server.maxConnections = 8
  server.active = () => busy
  return server
}
