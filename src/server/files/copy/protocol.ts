// The root helper's protocol (relay-manager-rootcopy): one request per connection on a unix socket that only the
// service user can open (root:relay-manager 0660). Newline-delimited JSON: the client sends ONE header line; for a
// copy, after the helper answers {"type":"ready"}, exactly `size` raw bytes follow (the file, read by the service from
// its own folder: the helper never opens a source path). The helper answers with progress lines and one final
// "result" or "error" line, then closes. Closing the connection cancels (the temporary file is removed).
//
// Shared by the client (Graph A) and the helper bundle: no imports besides the copy policy types.
import type { CopyConflict } from "@/lib/contracts/files"

export const ROOTCOPY_PROTOCOL = 1
/** The socket systemd creates for the helper (relay-manager-rootcopy.socket). */
export const ROOTCOPY_SOCKET_DEFAULT = "/run/relay-manager-rootcopy/rootcopy.sock"
/** The helper's own configuration, written by install.sh (root:root 0644): the service cannot change it. */
export const ROOTCOPY_CONFIG_DEFAULT = "/etc/relay-manager/rootcopy.env"
export const HEADER_MAX_BYTES = 16 * 1024
/** A copy larger than this is refused (sanity bound; free space is checked too). */
export const ROOTCOPY_MAX_BYTES = 1024 ** 4

export type HelperErrorCode =
  | "PROTOCOL" | "DISABLED" | "BUSY" | "AUTH" | "LOCKED" | "ACCOUNT" | "DENIED" | "NOT_FOUND" | "ACCESS" | "EXISTS"
  | "NO_SPACE" | "READ_ONLY" | "INVALID" | "IO" | "VERIFY" | "CANCELED"
  /** The elevation token is missing, expired, revoked, forged or bound to another session: ask the password again. */
  | "TOKEN"
  /** Mount/unmount: the device or mount point is not acceptable (system disk, not removable, not ours…). */
  | "DEVICE"
  /** Unmount: the filesystem is in use. */
  | "IN_USE"
  /** Mounting is not available (no mount helper, or it refused to start). */
  | "NO_MOUNT"

export type AccountState = "ok" | "no-user" | "not-sudo" | "locked" | "no-password" | "unsupported-hash" | "unreadable"

/** Elevation tokens live this long (the service drops them earlier on «Olvidar permisos»). */
export const ELEVATION_TTL_MS = 5 * 60_000
/** The service's login session (sha256 of user id, session version and login time, hex) and the web user id. */
export const SESSION_ID_RE = /^[0-9a-f]{64}$/
export const WEB_USER_RE = /^[A-Za-z0-9_-]{1,64}$/

/**
 * How a request authenticates: the sudo password, or an elevation token the helper issued before (HMAC-signed with
 * the helper's own key, bound to `session` and expiring). `session` is required with a token and to ask for one
 * (`issue`). A password request with `issue` gets `token` in its result.
 */
export interface HelperAuth {
  password?: string
  token?: string
  session?: { sid: string; webUser: string }
  issue?: boolean
}
type Authed<T> = T & HelperAuth

export type HelperRequest =
  | { v: 1; op: "ping" }
  | Authed<{ v: 1; op: "probe"; dir: string; list: boolean; hidden: boolean }>
  /** Read-only listing (folders and files, metadata only) of any browsable folder: the deny-list does not apply to
   * listing, the pseudo filesystems and the helpers' own state do. */
  | Authed<{ v: 1; op: "list"; dir: string; hidden: boolean }>
  | Authed<{ v: 1; op: "mkdir"; dir: string; name: string }>
  | Authed<{ v: 1; op: "copy"; dir: string; name: string; size: number; conflict: CopyConflict }>
  /** Mount a removable device (relayed to the mount helper, relay-manager-rootmount). */
  | Authed<{ v: 1; op: "mount"; device: string }>
  /** sync + umount + remove the empty mount folder. */
  | Authed<{ v: 1; op: "unmount"; mountPoint: string }>
  /** «Olvidar permisos»: the token is revoked until it expires (possession is the authorisation). */
  | { v: 1; op: "revoke"; token: string }

export interface PingResult {
  type: "result"
  op: "ping"
  version: string
  enabled: boolean
  /** The mount helper answers (relay-manager-rootmount.socket): «Montar» / «Expulsar» are available. */
  mount: { available: boolean; problem: string | null }
  /** The account whose password authenticates (the helper's own configuration, never the client's). */
  user: string
  account: AccountState
  /** Spanish explanation when the account cannot authenticate. */
  accountMessage: string | null
  /** How passwords are checked ("python3" / "perl"), null when neither works. */
  method: string | null
  methodError: string | null
  writePaths: string[]
}

export interface ProbeResult {
  type: "result"
  op: "probe"
  real: string
  /** Root can write there (permissions; a read-only mount answers EROFS). */
  writable: boolean
  freeBytes: number | null
  totalBytes: number | null
  folders: Array<{ name: string; hidden: boolean; link: boolean }> | null
  truncated: boolean
}
/** A token issued with a result (password + `issue`): opaque to the service; `expiresAt` in ms since the epoch. */
export interface IssuedToken { value: string; expiresAt: number }

export interface ListEntry { name: string; kind: "dir" | "file" | "other"; hidden: boolean; link: boolean; size: number | null; mtimeMs: number | null }
export interface ListResult {
  type: "result"
  op: "list"
  real: string
  entries: ListEntry[]
  truncated: boolean
  /** Root may write there (RM_COPY_ROOT_PATHS, deny-list, permissions). */
  writable: boolean
  freeBytes: number | null
  totalBytes: number | null
}
export interface MkdirResult { type: "result"; op: "mkdir"; real: string; name: string }
export interface CopyResult { type: "result"; op: "copy"; name: string | null; skipped: boolean; replaced: boolean; sha256: string | null; size: number }
export interface MountResult { type: "result"; op: "mount"; device: string; mountPoint: string; fsType: string; options: string }
export interface UnmountResult { type: "result"; op: "unmount"; mountPoint: string; removedDir: boolean }
export interface RevokeResult { type: "result"; op: "revoke" }

type WithToken<T> = T & { token?: IssuedToken }
export type HelperMsg =
  | { type: "ready" }
  | { type: "progress"; bytes: number }
  | { type: "verifying" }
  | PingResult | RevokeResult
  | WithToken<ProbeResult> | WithToken<ListResult> | WithToken<MkdirResult> | WithToken<CopyResult> | WithToken<MountResult> | WithToken<UnmountResult>
  | { type: "error"; code: HelperErrorCode; message: string }

const CONFLICTS: readonly string[] = ["replace", "keep", "skip"]

type Parsed = { ok: true; req: HelperRequest } | { ok: false; message: string }

const str = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max

const TOKEN_RE = /^[A-Za-z0-9_-]{16,1024}\.[A-Za-z0-9_-]{16,128}$/

/** The authentication fields of a request: a password or a token (with its session), checked for shape only. */
function parseAuth(r: Record<string, unknown>): { ok: true; auth: HelperAuth } | { ok: false; message: string } {
  const auth: HelperAuth = {}
  if (r.session !== undefined) {
    const s = r.session as Record<string, unknown> | null
    if (typeof s !== "object" || s === null || typeof s.sid !== "string" || !SESSION_ID_RE.test(s.sid) || typeof s.webUser !== "string" || !WEB_USER_RE.test(s.webUser)) {
      return { ok: false, message: "Sesión no válida." }
    }
    auth.session = { sid: s.sid, webUser: s.webUser }
  }
  if (r.password !== undefined) {
    if (!str(r.password, 512)) return { ok: false, message: "Falta la contraseña." }
    auth.password = r.password
    if (r.issue === true) {
      if (!auth.session) return { ok: false, message: "Falta la sesión para recordar los permisos." }
      auth.issue = true
    }
    return { ok: true, auth }
  }
  if (r.token !== undefined) {
    if (typeof r.token !== "string" || !TOKEN_RE.test(r.token)) return { ok: false, message: "Permiso no válido: escribe la contraseña." }
    if (!auth.session) return { ok: false, message: "Falta la sesión del permiso." }
    auth.token = r.token
    return { ok: true, auth }
  }
  return { ok: false, message: "Falta la contraseña." }
}

/**
 * Validates a header line. Unknown keys are ignored (a "user" sent by a client is never read: the helper always
 * authenticates its own configured sudo user).
 */
export function parseRequest(line: string): Parsed {
  let o: unknown
  try {
    o = JSON.parse(line)
  } catch {
    return { ok: false, message: "Petición no válida (JSON)." }
  }
  if (typeof o !== "object" || o === null || Array.isArray(o)) return { ok: false, message: "Petición no válida." }
  const r = o as Record<string, unknown>
  if (r.v !== ROOTCOPY_PROTOCOL) return { ok: false, message: "Versión del protocolo no admitida: actualiza Relay Manager." }
  if (r.op === "ping") return { ok: true, req: { v: 1, op: "ping" } }
  if (r.op === "revoke") {
    if (typeof r.token !== "string" || !TOKEN_RE.test(r.token)) return { ok: false, message: "Permiso no válido." }
    return { ok: true, req: { v: 1, op: "revoke", token: r.token } }
  }
  const a = parseAuth(r)
  if (!a.ok) return a
  const auth = a.auth
  if (r.op === "mount") {
    if (typeof r.device !== "string" || r.device.length > 64) return { ok: false, message: "Falta el dispositivo." }
    return { ok: true, req: { v: 1, op: "mount", device: r.device, ...auth } }
  }
  if (r.op === "unmount") {
    if (!str(r.mountPoint, 4096)) return { ok: false, message: "Falta el punto de montaje." }
    return { ok: true, req: { v: 1, op: "unmount", mountPoint: r.mountPoint, ...auth } }
  }
  if (!str(r.dir, 4096)) return { ok: false, message: "Falta la carpeta de destino." }
  const dir = r.dir
  if (r.op === "probe") {
    return { ok: true, req: { v: 1, op: "probe", dir, list: r.list === true, hidden: r.hidden === true, ...auth } }
  }
  if (r.op === "list") return { ok: true, req: { v: 1, op: "list", dir, hidden: r.hidden === true, ...auth } }
  if (!str(r.name, 1024)) return { ok: false, message: "Falta el nombre." }
  const name = r.name
  if (r.op === "mkdir") return { ok: true, req: { v: 1, op: "mkdir", dir, name, ...auth } }
  if (r.op === "copy") {
    if (typeof r.size !== "number" || !Number.isSafeInteger(r.size) || r.size < 0 || r.size > ROOTCOPY_MAX_BYTES) return { ok: false, message: "Tamaño no válido." }
    if (typeof r.conflict !== "string" || !CONFLICTS.includes(r.conflict)) return { ok: false, message: "Opción de conflicto no válida." }
    return { ok: true, req: { v: 1, op: "copy", dir, name, size: r.size, conflict: r.conflict as CopyConflict, ...auth } }
  }
  return { ok: false, message: "Operación desconocida." }
}

/** Splits a stream of bytes into lines (newline-delimited JSON), bounded. */
export class LineReader {
  private buf = ""
  constructor(private readonly max: number) {}
  /** Feeds bytes; returns the complete lines. Throws when a line is longer than the bound. */
  push(chunk: Buffer | string): string[] {
    this.buf += typeof chunk === "string" ? chunk : chunk.toString("utf8")
    const out: string[] = []
    for (;;) {
      const i = this.buf.indexOf("\n")
      if (i < 0) break
      out.push(this.buf.slice(0, i))
      this.buf = this.buf.slice(i + 1)
    }
    if (this.buf.length > this.max) throw new Error("línea demasiado larga")
    return out
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The mount helper (relay-manager-rootmount): a second, tiny root unit WITHOUT a private mount namespace (a mount made
// inside the copy helper's ProtectSystem= namespace would never reach the host nor the main service). Its socket is
// root:root 0600: only the copy helper (root, after authenticating the sudo password or token) talks to it. Same
// framing: one JSON line in, one JSON line out. It re-validates everything (device, removable, not a system disk,
// mount point under /media) on its own.

export const ROOTMOUNT_SOCKET_DEFAULT = "/run/relay-manager-rootmount/rootmount.sock"

export type MountRequest =
  | { v: 1; op: "ping" }
  | { v: 1; op: "mount"; device: string }
  | { v: 1; op: "unmount"; mountPoint: string }

export type MountMessage =
  | { type: "result"; op: "ping"; version: string }
  | MountResult
  | UnmountResult
  | { type: "error"; code: HelperErrorCode; message: string }

export function parseMountRequest(line: string): { ok: true; req: MountRequest } | { ok: false; message: string } {
  let o: unknown
  try {
    o = JSON.parse(line)
  } catch {
    return { ok: false, message: "Petición no válida (JSON)." }
  }
  if (typeof o !== "object" || o === null || Array.isArray(o)) return { ok: false, message: "Petición no válida." }
  const r = o as Record<string, unknown>
  if (r.v !== ROOTCOPY_PROTOCOL) return { ok: false, message: "Versión del protocolo no admitida." }
  if (r.op === "ping") return { ok: true, req: { v: 1, op: "ping" } }
  if (r.op === "mount" && typeof r.device === "string" && r.device.length <= 64) return { ok: true, req: { v: 1, op: "mount", device: r.device } }
  if (r.op === "unmount" && str(r.mountPoint, 4096)) return { ok: true, req: { v: 1, op: "unmount", mountPoint: r.mountPoint } }
  return { ok: false, message: "Operación desconocida." }
}
