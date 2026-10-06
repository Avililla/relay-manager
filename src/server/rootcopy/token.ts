// Elevation tokens of the copy helper: after the sudo password, the browser session may act «como administrador» for
// ELEVATION_TTL_MS (5 min, absolute) without typing it again. The token is HMAC-SHA256-signed with a key only root can
// read (<state dir>/token.key, 0600), bound to the service's login session id and the web user, and revocable
// («Olvidar permisos»: revoked.json until it would expire anyway). The service keeps it server-side; the browser never
// sees it. A wrong, expired, revoked or foreign token is just refused (no lockout: guessing an HMAC is hopeless).
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { ELEVATION_TTL_MS, type IssuedToken } from "@/server/files/copy/protocol"

/** The web session and user the token is for, and the sudo account whose password issued it. */
export interface TokenSession { sid: string; webUser: string; rootUser?: string }
interface Payload { v: 1; sid: string; wu: string; ru: string; iat: number; exp: number; jti: string }

export interface TokenStoreOptions {
  /** <state dir>/token.key; null = an in-memory key (tests, or a helper without a state directory). */
  keyFile: string | null
  /** <state dir>/revoked.json; null = in memory. */
  revokedFile: string | null
  key?: Buffer
  ttlMs?: number
  now?: () => number
}

export type TokenCheck = { ok: true; jti: string; exp: number } | { ok: false; message: string }

const b64 = (b: Buffer) => b.toString("base64url")

function loadKey(file: string): Buffer {
  try {
    const k = fs.readFileSync(file)
    if (k.length === 32) return k
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e
  }
  const key = crypto.randomBytes(32)
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}`
  fs.writeFileSync(tmp, key, { mode: 0o600, flag: "wx" })
  try {
    // link(): never replaces a key another process wrote meanwhile (then that one is used).
    fs.linkSync(tmp, file)
    return key
  } catch {
    const k = fs.readFileSync(file)
    if (k.length !== 32) throw new Error(`${file}: clave no válida`)
    return k
  } finally {
    fs.rmSync(tmp, { force: true })
  }
}

export class TokenStore {
  private keyCache: Buffer | null
  private readonly ttl: number
  private readonly now: () => number
  private revokedMem = new Map<string, number>()

  constructor(private readonly o: TokenStoreOptions) {
    this.keyCache = o.key ?? null
    this.ttl = o.ttlMs ?? ELEVATION_TTL_MS
    this.now = o.now ?? (() => Date.now())
  }

  private key(): Buffer {
    if (!this.keyCache) this.keyCache = this.o.keyFile ? loadKey(this.o.keyFile) : crypto.randomBytes(32)
    return this.keyCache
  }

  private sign(body: string): string {
    return b64(crypto.createHmac("sha256", this.key()).update(body).digest())
  }

  issue(s: TokenSession): IssuedToken {
    const iat = this.now()
    const p: Payload = { v: 1, sid: s.sid, wu: s.webUser, ru: s.rootUser ?? "", iat, exp: iat + this.ttl, jti: b64(crypto.randomBytes(12)) }
    const body = b64(Buffer.from(JSON.stringify(p), "utf8"))
    return { value: `${body}.${this.sign(body)}`, expiresAt: p.exp }
  }

  /** Signature, expiry and revocation only (who it belongs to is checked by verify). */
  private decode(token: string): { ok: true; p: Payload } | { ok: false; message: string } {
    const dot = token.indexOf(".")
    if (dot <= 0) return { ok: false, message: "Permiso no válido." }
    const body = token.slice(0, dot)
    const sig = Buffer.from(token.slice(dot + 1), "base64url")
    const want = crypto.createHmac("sha256", this.key()).update(body).digest()
    if (sig.length !== want.length || !crypto.timingSafeEqual(sig, want)) return { ok: false, message: "Permiso no válido." }
    let p: Payload
    try {
      p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Payload
    } catch {
      return { ok: false, message: "Permiso no válido." }
    }
    if (p.v !== 1 || typeof p.exp !== "number" || typeof p.jti !== "string" || typeof p.sid !== "string" || typeof p.wu !== "string" || typeof p.ru !== "string") {
      return { ok: false, message: "Permiso no válido." }
    }
    if (p.exp <= this.now()) return { ok: false, message: "Los permisos de administrador han caducado." }
    if (this.revoked().has(p.jti)) return { ok: false, message: "Los permisos de administrador se han olvidado." }
    return { ok: true, p }
  }

  verify(token: string, s: TokenSession | undefined): TokenCheck {
    const d = this.decode(token)
    if (!d.ok) return d
    if (!s || d.p.sid !== s.sid || d.p.wu !== s.webUser) return { ok: false, message: "Permiso de otra sesión." }
    // Issued for another sudo account (RM_SUDO_USER changed since): not valid any more.
    if (d.p.ru !== (s.rootUser ?? "")) return { ok: false, message: "Permiso de otra cuenta de administrador." }
    return { ok: true, jti: d.p.jti, exp: d.p.exp }
  }

  /** Revokes a valid token until it expires; false when it was not valid anyway. */
  revoke(token: string): boolean {
    const d = this.decode(token)
    if (!d.ok) return false
    const list = this.revoked()
    list.set(d.p.jti, d.p.exp)
    this.saveRevoked(list)
    return true
  }

  private revoked(): Map<string, number> {
    let m = this.revokedMem
    if (this.o.revokedFile) {
      m = new Map()
      try {
        const v = JSON.parse(fs.readFileSync(this.o.revokedFile, "utf8")) as Record<string, unknown>
        for (const [k, exp] of Object.entries(v)) if (typeof exp === "number") m.set(k, exp)
      } catch {
        // none yet
      }
    }
    const t = this.now()
    for (const [k, exp] of m) if (exp <= t) m.delete(k)
    return m
  }

  private saveRevoked(m: Map<string, number>): void {
    this.revokedMem = m
    if (!this.o.revokedFile) return
    const tmp = `${this.o.revokedFile}.tmp`
    fs.mkdirSync(path.dirname(this.o.revokedFile), { recursive: true, mode: 0o700 })
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(m)), { mode: 0o600 })
    fs.renameSync(tmp, this.o.revokedFile)
  }
}
