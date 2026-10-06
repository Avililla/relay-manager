// «Enviar a equipo»: one file from the bench to an equipment over SSH (ssh2, pure JavaScript).
//
// Route: the TCP connection is made here, exactly like the Ethernet access forward (TcpForward): to host:port, and in
// "switch" mode with localAddress = the server's address in that port's VLAN, which policy routing sends out of that
// VLAN interface only (EADDRNOTAVAIL → the VLAN is gone: never retried from another address). It never goes through
// the public access port.
//
// Protocol: SFTP when the server has the subsystem (streamed with a window of writes in flight, to a temporary name
// in the destination folder, fchmod, then rename into place); otherwise the scp protocol over `scp -t <dir>` (same
// temporary name, then `chmod && mv -f`). Then the size is checked and, if the equipment has sha256sum or md5sum, the
// checksum ("verificado" / "no verificable").
//
// Host keys: every equipment has the same IP, so a key is never pinned by address: any key is accepted and reported
// (onHostKey); the caller compares it with the one recorded for that equipment.
import crypto from "node:crypto"
import net from "node:net"
import { Client, type ClientChannel, type SFTPWrapper, type Stats } from "ssh2"
import { remoteBasename, remoteDirname, remoteJoin, resolveRemotePath, type RemotePath } from "@/lib/files/remote-path"
import { sendErrors as E } from "@/lib/i18n/send"
import { isBindError } from "@/server/accesses/tcp-forward"
import { parseChecksum, parseDfFree, remoteCmd } from "./remote-cmd"
import { ScpAborted, ScpError, scpSend } from "./scp"

export type SendErrorKind =
  | "auth" | "unreachable" | "refused" | "network" | "handshake" | "timeout" | "permission" | "no-space" | "path"
  | "canceled" | "checksum" | "no-transfer" | "remote" | "source"

export class SendError extends Error {
  constructor(readonly kind: SendErrorKind, message: string) {
    super(message)
    this.name = "SendError"
  }
}

export interface TransferRoute {
  host: string
  port: number
  /** "switch" mode: the server's address in the port's VLAN. */
  localAddress: string | null
  switchPort: number | null
  link: "up" | "down" | "unknown" | null
  /** Message when localAddress is not on the server any more. */
  bindError: string | null
}

export interface TransferSource {
  name: string
  size: number
  /** 0o644 or 0o755 (the source is executable). */
  mode: number
  /** The file, in order, `chunkSize` bytes at a time (never more than `size` in total). */
  chunks(chunkSize: number): AsyncIterable<Buffer>
}

export interface HostKey { type: string; fingerprint: string }

export type TransferPhase = "connecting" | "sending" | "verifying"

export interface TransferOptions {
  route: TransferRoute
  username: string
  password: string
  dest: Extract<RemotePath, { ok: true }>
  /** Several files in one send: the destination must be an existing folder. */
  multi: boolean
  source: TransferSource
  signal: AbortSignal
  onPhase?: (phase: TransferPhase) => void
  onProgress?: (sent: number) => void
  onHostKey?: (key: HostKey) => void
  /** The login worked (the caller may remember it now). */
  onAuthenticated?: () => void
  timeouts?: { connectMs?: number; readyMs?: number; stallMs?: number; commandMs?: number }
  /** Tests: force the scp protocol even if the server has SFTP. */
  forceScp?: boolean
  /** Tests only (a real unprivileged sshd cannot check passwords): log in with this private key instead. */
  privateKey?: string
}

export interface TransferResult {
  protocol: "sftp" | "scp"
  finalPath: string
  replaced: boolean
  verification: "verified" | "unverifiable"
  checksum: "sha256" | "md5" | null
  hostKey: HostKey | null
}

const CHUNK = 32 * 1024
const WINDOW = 32 // SFTP writes in flight (1 MiB)
const SFTP_NO_SUCH_FILE = 2
const SFTP_PERMISSION_DENIED = 3

/** OpenSSH-style fingerprint ("SHA256:<base64 without padding>") and the key type from the key blob. */
export function hostKeyOf(key: Buffer): HostKey {
  let type = "desconocido"
  if (key.length >= 4) {
    const n = key.readUInt32BE(0)
    if (n > 0 && n < 64 && key.length >= 4 + n) type = key.subarray(4, 4 + n).toString("ascii")
  }
  return { type, fingerprint: `SHA256:${crypto.createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}` }
}

function target(r: TransferRoute): string {
  return `${r.host}:${r.port}`
}

function unreachable(r: TransferRoute): SendError {
  if (r.switchPort !== null) {
    return new SendError("unreachable", r.link === "down" ? E.unreachableSwitch(r.switchPort) : E.unreachableSwitchUp(r.switchPort, target(r)))
  }
  return new SendError("unreachable", E.unreachableIp(target(r)))
}

function netError(err: NodeJS.ErrnoException, r: TransferRoute): SendError {
  if (isBindError(err, r.localAddress)) return new SendError("network", r.bindError ?? E.network(err.message))
  if (err.code === "ECONNREFUSED") return new SendError("refused", E.refused(r.port))
  return unreachable(r)
}

/** The TCP connection, the same way as the Ethernet access forward. */
function tcpConnect(r: TransferRoute, ms: number, signal: AbortSignal): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host: r.host, port: r.port, ...(r.localAddress ? { localAddress: r.localAddress } : {}) })
    let done = false
    const finish = (err: SendError | null) => {
      if (done) return
      done = true
      clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
      s.removeListener("error", onError)
      if (err) {
        s.destroy()
        reject(err)
      } else resolve(s)
    }
    const onError = (e: NodeJS.ErrnoException) => finish(netError(e, r))
    const onAbort = () => finish(new SendError("canceled", E.canceled))
    const timer = setTimeout(() => finish(unreachable(r)), ms)
    signal.addEventListener("abort", onAbort, { once: true })
    s.once("error", onError)
    s.once("connect", () => {
      s.setNoDelay(true)
      s.setKeepAlive(true, 10_000)
      finish(null)
    })
  })
}

function sshError(err: Error & { level?: string }): SendError {
  if (err.level === "client-authentication") return new SendError("auth", E.auth)
  if (err.level === "client-timeout") return new SendError("timeout", E.handshakeTimeout)
  return new SendError("handshake", E.handshake(err.message))
}

interface ExecResult { code: number | null; stdout: string; stderr: string }

export async function sendFile(o: TransferOptions): Promise<TransferResult> {
  const t = { connectMs: 8000, readyMs: 20_000, stallMs: 30_000, commandMs: 20_000, ...o.timeouts }
  const signal = o.signal
  const canceled = () => new SendError("canceled", E.canceled)
  if (signal.aborted) throw canceled()
  o.onPhase?.("connecting")
  const sock = await tcpConnect(o.route, t.connectMs, signal)
  const conn = new Client()
  let hostKey: HostKey | null = null
  /** Why the connection was torn down by us (stall, command timeout); preferred over the resulting socket error. */
  let fatal: SendError | null = null
  let closed = false
  let lastActivity = Date.now()
  /** The stall watchdog only looks at the data phase (commands have their own timeouts; a checksum can take long). */
  let watching = false
  const touch = () => { lastActivity = Date.now() }
  const kill = (e: SendError) => {
    fatal ??= e
    closed = true
    conn.end()
    sock.destroy()
  }
  conn.on("close", () => { closed = true })
  const watchdog = setInterval(() => {
    if (watching && Date.now() - lastActivity > t.stallMs) kill(new SendError("timeout", E.stalled))
  }, 1000)
  watchdog.unref()
  // After a cancel, whatever is in flight gets a few seconds to finish its cleanup; then the connection goes.
  let hardStop: NodeJS.Timeout | null = null
  const onAbort = () => {
    hardStop = setTimeout(() => kill(canceled()), 5000)
    hardStop.unref()
  }
  signal.addEventListener("abort", onAbort, { once: true })

  /** An ssh2 callback operation with a timeout; rejects at once on cancel (cleanup runs after). */
  function op<T>(start: (cb: (err: Error | null | undefined, v?: T) => void) => void, ms = t.commandMs): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (signal.aborted) return reject(canceled())
      if (closed) return reject(fatal ?? new SendError("unreachable", E.stalled))
      let settled = false
      const end = (err: unknown, v?: T) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal.removeEventListener("abort", ab)
        touch()
        if (err) reject(err)
        else resolve(v as T)
      }
      const ab = () => end(canceled())
      const timer = setTimeout(() => {
        kill(new SendError("timeout", E.commandTimeout))
        end(fatal)
      }, ms)
      signal.addEventListener("abort", ab, { once: true })
      try {
        start((err, v) => end(err ?? null, v))
      } catch (e) {
        end(e)
      }
    })
  }

  function exec(cmd: string, ms = t.commandMs, maxBytes = 64 * 1024): Promise<ExecResult> {
    return op<ExecResult>((cb) => {
      conn.exec(cmd, (err, ch) => {
        if (err) return cb(err)
        let stdout = ""
        let stderr = ""
        let code: number | null = null
        ch.on("data", (d: Buffer) => { if (stdout.length < maxBytes) stdout += d.toString("utf8") })
        ch.stderr.on("data", (d: Buffer) => { if (stderr.length < maxBytes) stderr += d.toString("utf8") })
        ch.on("exit", (c: number | null) => { code = typeof c === "number" ? c : null })
        ch.on("close", () => cb(null, { code, stdout, stderr }))
      })
    }, ms)
  }

  let tmp: string | null = null
  let sftp: SFTPWrapper | null = null
  try {
    // --- SSH session -----------------------------------------------------------------------------------------
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const settle = (err: SendError | null) => {
        if (settled) return
        settled = true
        signal.removeEventListener("abort", onAbortReady)
        if (err) reject(err)
        else resolve()
      }
      const onAbortReady = () => settle(canceled())
      // One permanent handler (an 'error' without listeners would crash the process): before "ready" it fails the
      // login; after, it is remembered and the operation in progress fails with the closed connection.
      conn.on("error", (e: Error & { level?: string }) => {
        if (!settled) settle(signal.aborted ? canceled() : fatal ?? sshError(e))
        else fatal ??= signal.aborted ? canceled() : new SendError("unreachable", E.handshake(e.message))
      })
      conn.once("ready", () => settle(null))
      conn.once("close", () => settle(fatal ?? new SendError("handshake", E.handshake("conexión cerrada"))))
      conn.on("keyboard-interactive", (_name, _instr, _lang, prompts, finish) => finish(prompts.map(() => o.password)))
      signal.addEventListener("abort", onAbortReady, { once: true })
      conn.connect({
        sock,
        username: o.username,
        ...(o.privateKey ? { privateKey: o.privateKey } : { password: o.password, tryKeyboard: true }),
        readyTimeout: t.readyMs,
        keepaliveInterval: 10_000,
        keepaliveCountMax: 3,
        hostVerifier: (key: Buffer) => {
          hostKey = hostKeyOf(key)
          o.onHostKey?.(hostKey)
          return true
        },
      })
    })
    touch()
    o.onAuthenticated?.()

    if (!o.forceScp) {
      sftp = await op<SFTPWrapper>((cb) => conn.sftp((err, s) => cb(err, s))).catch((e: unknown) => {
        if (e instanceof SendError) throw e
        return null // no SFTP subsystem (dropbear without sftp-server): scp
      })
    }
    const s = sftp
    const size = o.source.size
    const mode = o.source.mode

    // --- Where: home, destination, final name -----------------------------------------------------------------
    let home = "/"
    if (o.dest.base === "home") {
      const h = s ? await op<string>((cb) => s.realpath(".", (err, p) => cb(err, p))).catch(() => "") : ""
      home = h.startsWith("/") ? h : (await exec(remoteCmd.home())).stdout.trim()
      if (!home.startsWith("/")) throw new SendError("path", E.noHome(o.username))
    }
    const P = resolveRemotePath(o.dest, home)
    const parent = remoteDirname(P)
    const kindOf = async (p: string): Promise<"dir" | "file" | "none"> => {
      if (s) {
        const st = await op<Stats>((cb) => s.stat(p, (err, v) => cb(err, v))).catch((e: { code?: number }) => {
          if (e instanceof SendError) throw e
          if (e.code === SFTP_NO_SUCH_FILE) return null
          if (e.code === SFTP_PERMISSION_DENIED) throw new SendError("permission", E.permission(remoteDirname(p), o.username))
          throw new SendError("remote", E.remote(String((e as Error).message ?? e)))
        })
        return !st ? "none" : st.isDirectory() ? "dir" : "file"
      }
      const r = await exec(remoteCmd.isDir(p))
      const w = r.stdout.trim()
      return w === "dir" ? "dir" : w === "file" ? "file" : "none"
    }
    let kind: "dir" | "file" | "missing" | "noparent"
    if (s) {
      const k = await kindOf(P)
      kind = k === "dir" ? "dir" : k === "file" ? "file" : (await kindOf(parent)) === "dir" ? "missing" : "noparent"
    } else {
      const r = await exec(remoteCmd.probe(P, parent))
      const w = r.stdout.trim()
      if (w !== "dir" && w !== "file" && w !== "missing" && w !== "noparent") throw new SendError("remote", E.remote((r.stderr || r.stdout).trim().slice(0, 300) || `código ${r.code}`))
      kind = w
    }
    let final: string
    let replaced = false
    if (kind === "dir") {
      final = remoteJoin(P, o.source.name)
      const k = await kindOf(final)
      if (k === "dir") throw new SendError("path", E.targetIsDir(final))
      replaced = k === "file"
    } else if (kind === "file") {
      if (o.dest.trailingSlash) throw new SendError("path", E.notADir(P))
      if (o.multi) throw new SendError("path", E.multiNeedsDir)
      final = P
      replaced = true
    } else if (kind === "missing") {
      if (o.dest.trailingSlash) throw new SendError("path", E.noDir(P))
      if (o.multi) throw new SendError("path", E.multiNeedsDir)
      final = P
    } else {
      throw new SendError("path", E.noDir(parent))
    }
    const dir = remoteDirname(final)

    // --- Room for it? (best effort: statvfs@openssh.com, or df) ------------------------------------------------
    const freeSpace = async (ms = t.commandMs): Promise<number | null> => {
      if (s) {
        const v = await op<{ f_bavail: number | bigint; f_frsize: number | bigint }>((cb) => s.ext_openssh_statvfs(dir, (err, x) => cb(err, x as never)), ms)
          .then((x) => Number(x.f_bavail) * Number(x.f_frsize))
          .catch((e: unknown) => { if (e instanceof SendError) throw e; return null })
        if (v !== null && Number.isFinite(v)) return v
      }
      return exec(remoteCmd.freeKb(dir), ms).then((r) => (r.code === 0 ? parseDfFree(r.stdout) : null)).catch((e: unknown) => {
        if (e instanceof SendError && (e.kind === "canceled" || e.kind === "timeout")) throw e
        return null // no exec, or no df
      })
    }
    const free = await freeSpace()
    if (free !== null && free < size) throw new SendError("no-space", E.noSpace(free, size))

    // --- Send ----------------------------------------------------------------------------------------------------
    o.onPhase?.("sending")
    touch()
    watching = true
    const sha256 = crypto.createHash("sha256")
    const md5 = crypto.createHash("md5")
    let read = 0
    let progressBytes = 0
    async function* data(): AsyncGenerator<Buffer> {
      for await (const c of o.source.chunks(CHUNK)) {
        read += c.length
        if (read > size) throw new SendError("source", E.sourceChanged)
        sha256.update(c)
        md5.update(c)
        yield c
      }
      if (read !== size) throw new SendError("source", E.sourceChanged)
    }
    const tmpName = `.rm-send-${crypto.randomBytes(6).toString("hex")}.part`
    const tmpPath = remoteJoin(dir, tmpName)
    const mapWriteError = async (e: unknown): Promise<SendError> => {
      if (e instanceof SendError) return e
      const code = (e as { code?: number }).code
      const msg = e instanceof Error ? e.message : String(e)
      if (code === SFTP_PERMISSION_DENIED || /permission denied|read-only file system/i.test(msg)) return new SendError("permission", E.permission(dir, o.username))
      if (/no space|ENOSPC|disk full|quota/i.test(msg)) return new SendError("no-space", E.noSpace(null, size))
      if (!closed && !signal.aborted) {
        // SFTP v3 has no "disk full" status (OpenSSH answers "Failure"), nor has a failed scp always a clear text:
        // look at the free space to say so.
        const f = await freeSpace(5000).catch(() => null)
        if (f !== null && (f < CHUNK * WINDOW || f < size - progressBytes)) return new SendError("no-space", E.noSpace(f, size))
      }
      return new SendError("remote", E.remote(msg))
    }

    if (s) {
      let handle: Buffer
      tmp = tmpPath // before the request: a cancel while it is in flight must still remove what it creates
      try {
        handle = await op<Buffer>((cb) => s.open(tmpPath, "w", { mode }, (err, h) => cb(err, h)))
      } catch (e) {
        throw await mapWriteError(e)
      }
      let inflight = 0
      let acked = 0
      let pos = 0
      let failure: unknown = null
      let wake: (() => void) | null = null
      const waitSlot = () => new Promise<void>((r) => { wake = r })
      const onDead = () => { wake?.() }
      conn.once("close", onDead)
      signal.addEventListener("abort", onDead, { once: true })
      try {
        for await (const chunk of data()) {
          while (inflight >= WINDOW && !failure && !signal.aborted && !closed) await waitSlot()
          if (signal.aborted) throw canceled()
          if (failure) throw failure
          if (closed) throw fatal ?? unreachable(o.route)
          const at = pos
          pos += chunk.length
          inflight++
          const onWritten = (err?: Error | null) => {
            inflight--
            if (err) failure ??= err
            else {
              acked += chunk.length
              progressBytes = acked
              touch()
              o.onProgress?.(acked)
            }
            const w = wake
            wake = null
            w?.()
          }
          try {
            s.write(handle, chunk, 0, chunk.length, at, onWritten)
          } catch (e) {
            onWritten(e instanceof Error ? e : new Error(String(e)))
          }
        }
        while (inflight > 0 && !failure && !signal.aborted && !closed) await waitSlot()
        if (signal.aborted) throw canceled()
        if (failure) throw failure
        if (closed) throw fatal ?? unreachable(o.route)
      } catch (e) {
        throw await mapWriteError(e)
      } finally {
        conn.removeListener("close", onDead)
        signal.removeEventListener("abort", onDead)
      }
      try {
        await op<void>((cb) => s.fchmod(handle, mode, (err) => cb(err)))
        await op<void>((cb) => s.close(handle, (err) => cb(err)))
      } catch (e) {
        throw await mapWriteError(e)
      }
      // Into place: posix-rename@openssh.com replaces atomically; plain SFTP rename refuses an existing target.
      try {
        await op<void>((cb) => s.ext_openssh_rename(tmpPath, final, (err) => cb(err)))
      } catch (e) {
        if (e instanceof SendError) throw e
        if (!/does not support/i.test(e instanceof Error ? e.message : "")) throw await mapWriteError(e)
        if (replaced) await op<void>((cb) => s.unlink(final, (err) => cb(err))).catch(async (err: unknown) => { throw await mapWriteError(err) })
        await op<void>((cb) => s.rename(tmpPath, final, (err) => cb(err))).catch(async (err: unknown) => { throw await mapWriteError(err) })
      }
      tmp = null
    } else {
      // scp: the sink writes <dir>/<tmpName>; stdout carries the acks, stderr the messages.
      tmp = tmpPath
      const ch = await op<ClientChannel>((cb) => conn.exec(remoteCmd.scpSink(dir), (err, c) => cb(err, c)))
      let exitCode: number | null = null
      let stderr = ""
      ch.on("exit", (c: number | null) => { exitCode = typeof c === "number" ? c : null })
      ch.stderr.on("data", (d: Buffer) => { if (stderr.length < 8192) stderr += d.toString("utf8") })
      const closedCh = new Promise<void>((r) => ch.once("close", () => r()))
      try {
        await scpSend(ch, {
          name: tmpName, size, mode, data: data(), signal,
          onProgress: (n) => {
            progressBytes = n
            touch()
            o.onProgress?.(n)
          },
        })
        await Promise.race([closedCh, new Promise((r) => setTimeout(r, t.commandMs).unref())])
      } catch (e) {
        if (e instanceof ScpAborted || signal.aborted) throw canceled()
        await Promise.race([closedCh, new Promise((r) => setTimeout(r, 2000).unref())])
        if (e instanceof SendError) throw e
        if (exitCode === 127 || /not found|no such file or directory.*scp/i.test(stderr)) throw new SendError("no-transfer", E.noSftpNoScp)
        const msg = e instanceof ScpError ? (e.remote ?? e.message) : e instanceof Error ? e.message : String(e)
        throw await mapWriteError(new Error(`${msg}${stderr && !msg.includes(stderr.trim()) ? ` ${stderr.trim()}` : ""}`.trim()))
      }
      const c = await exec(remoteCmd.commit(tmpPath, final, mode))
      if (c.code !== 0) throw await mapWriteError(new Error((c.stderr || c.stdout).trim() || `código ${c.code}`))
      tmp = null
    }

    // --- Verify --------------------------------------------------------------------------------------------------
    watching = false
    o.onPhase?.("verifying")
    const local = { sha256: sha256.digest("hex"), md5: md5.digest("hex") }
    let remoteSize: number | null = null
    if (s) {
      const st = await op<Stats>((cb) => s.stat(final, (err, v) => cb(err, v))).catch((e: unknown) => {
        if (e instanceof SendError) throw e
        return null
      })
      remoteSize = st ? Number(st.size) : null
    } else {
      const r = await exec(remoteCmd.size(final)).catch((e: unknown) => {
        if (e instanceof SendError && e.kind === "canceled") throw e
        return null
      })
      const n = r && r.code === 0 ? Number(r.stdout.trim()) : NaN
      remoteSize = Number.isFinite(n) ? n : null
    }
    if (remoteSize !== null && remoteSize !== size) throw new SendError("checksum", E.sizeMismatch(remoteSize, size))
    let verification: TransferResult["verification"] = "unverifiable"
    let checksum: TransferResult["checksum"] = null
    // A slow equipment reads a big file at a few MB/s: give the checksum time (the file is already in place, so a
    // checksum that does not finish in time is "no verificable", not a failed send).
    const checksumMs = Math.max(t.commandMs, 120_000, Math.ceil(size / (2 * 1024 * 1024)) * 1000)
    for (const algo of ["sha256", "md5"] as const) {
      if (closed) break
      const r = await exec(remoteCmd.checksum(algo, final), checksumMs).catch((e: unknown) => {
        if (e instanceof SendError && e.kind === "canceled") throw e
        return null // no exec (an SFTP-only account), or too slow: not verifiable
      })
      if (!r) break
      const got = r.code === 0 ? parseChecksum(r.stdout, algo) : null
      if (!got) continue
      if (got !== local[algo]) throw new SendError("checksum", E.checksumMismatch(algo))
      verification = "verified"
      checksum = algo
      break
    }
    return { protocol: s ? "sftp" : "scp", finalPath: final, replaced, verification, checksum, hostKey }
  } catch (e) {
    const err = signal.aborted ? canceled() : fatal ?? toSendError(e)
    // Leave nothing behind: remove the temporary file (bounded; skipped if the connection is gone).
    if (tmp && !closed) {
      const p = tmp
      const sf = sftp
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 3000)
        timer.unref()
        const done = () => { clearTimeout(timer); resolve() }
        try {
          if (sf) sf.unlink(p, () => done())
          else conn.exec(remoteCmd.remove(p), (er, ch) => { if (er) return done(); ch.on("close", done); ch.resume() })
        } catch {
          done()
        }
      })
    }
    throw err
  } finally {
    clearInterval(watchdog)
    if (hardStop) clearTimeout(hardStop)
    signal.removeEventListener("abort", onAbort)
    conn.end()
    setTimeout(() => sock.destroy(), 1000).unref()
  }
}

function toSendError(e: unknown): SendError {
  if (e instanceof SendError) return e
  if (e instanceof ScpAborted) return new SendError("canceled", E.canceled)
  const msg = e instanceof Error ? e.message : String(e)
  return new SendError("remote", E.remote(msg))
}

/** A path for messages: the equipment's folder of a final path. */
export const folderOf = remoteDirname
export const nameOf = remoteBasename
