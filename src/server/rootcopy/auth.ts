// Root helper (relay-manager-rootcopy): who authenticates a copy «como administrador (sudo)» and how.
//
// Always ONE account, from the helper's own root-owned configuration (RM_SUDO_USER: the user that installed the app),
// never from the request. It must exist (/etc/passwd), be root or a member of a sudo-capable group (RM_COPY_SUDO_GROUPS:
// sudo, wheel, admin), not be locked or expired, and its password must match /etc/shadow. The hash is computed by the
// system's own crypt(3) (libxcrypt: yescrypt $y$, sha512 $6$, sha256 $5$, bcrypt $2b$) through python3 (ctypes on
// libcrypt.so.1, or the crypt module) or, without python3, perl (perl-base is always installed on Debian and Ubuntu):
// the password travels on the child's stdin, never in argv or the environment. The comparison is constant time.
// Failed attempts are limited (5 in 10 minutes → 10 minutes locked), persisted in the helper's state directory.
import { spawn } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import type { AccountState } from "@/server/files/copy/protocol"

export interface AccountFiles { passwd: string; group: string; shadow: string }
export const SYSTEM_ACCOUNT_FILES: AccountFiles = { passwd: "/etc/passwd", group: "/etc/group", shadow: "/etc/shadow" }

export interface AccountStatus {
  state: AccountState
  /** Spanish explanation when the account cannot authenticate. */
  message: string | null
  /** The shadow hash (only when state is "ok"). */
  hash: string | null
}

const SUPPORTED_HASH = /^\$(y|gy|7|6|5|2[aby])\$/
const USER_RE = /^[a-z_][a-z0-9_.-]{0,31}\$?$/i

const rootNoPassword = "La cuenta root no tiene contraseña (lo normal en Debian y Ubuntu, que usan sudo): Relay Manager tiene que usar la contraseña de un usuario con sudo. Reinstala con «sudo ./install.sh --sudo-user <usuario>»."

function fields(text: string, name: string): string[] | null {
  for (const line of text.split("\n")) {
    const f = line.split(":")
    if (f[0] === name) return f
  }
  return null
}

/** Is the account usable to authenticate? Pure (the three files' contents). */
export function accountStatus(user: string, sudoGroups: readonly string[], texts: { passwd: string; group: string; shadow: string | null }, nowMs = Date.now()): AccountStatus {
  const fail = (state: AccountState, message: string): AccountStatus => ({ state, message, hash: null })
  if (!USER_RE.test(user)) return fail("no-user", `El usuario configurado («${user}») no es válido (RM_SUDO_USER).`)
  const pw = fields(texts.passwd, user)
  if (!pw || pw.length < 7) return fail("no-user", `El usuario «${user}» no existe en este equipo (RM_SUDO_USER). Reinstala con «sudo ./install.sh --sudo-user <usuario>».`)
  const uid = Number(pw[2])
  const gid = pw[3]
  if (uid !== 0) {
    let member = false
    for (const line of texts.group.split("\n")) {
      const g = line.split(":")
      if (g.length < 4 || !sudoGroups.includes(g[0])) continue
      if (g[2] === gid || g[3].split(",").map((s) => s.trim()).includes(user)) member = true
    }
    if (!member) return fail("not-sudo", `«${user}» no es administrador de este equipo: no está en ninguno de los grupos ${sudoGroups.join(", ")} (RM_COPY_SUDO_GROUPS).`)
  }
  if (texts.shadow === null) return fail("unreadable", "No se puede leer /etc/shadow (el ayudante debe ejecutarse como root).")
  const sh = fields(texts.shadow, user)
  if (!sh || sh.length < 2) return fail("no-password", uid === 0 ? rootNoPassword : `«${user}» no tiene contraseña en /etc/shadow.`)
  const hash = sh[1]
  if (hash === "" || hash === "!" || hash === "*" || hash === "!!" || hash === "!*") {
    return fail(hash === "" ? "no-password" : "locked", uid === 0 ? rootNoPassword : hash === "" ? `«${user}» no tiene contraseña: ponle una con «sudo passwd ${user}».` : `La cuenta «${user}» está bloqueada (sin contraseña).`)
  }
  if (hash.startsWith("!") || hash.startsWith("*")) {
    return fail("locked", uid === 0 ? rootNoPassword : `La cuenta «${user}» está bloqueada: desbloquéala con «sudo passwd -u ${user}».`)
  }
  const expire = sh[7]
  if (expire && /^\d+$/.test(expire) && Number(expire) * 86_400_000 <= nowMs) return fail("locked", `La cuenta «${user}» ha caducado (chage).`)
  if (!SUPPORTED_HASH.test(hash)) return fail("unsupported-hash", `La contraseña de «${user}» usa un formato que no se admite (se admiten yescrypt, sha512, sha256 y bcrypt).`)
  return { state: "ok", message: null, hash }
}

/** Reads the three files (shadow may be unreadable when not root: null). */
export async function readAccountTexts(files: AccountFiles): Promise<{ passwd: string; group: string; shadow: string | null }> {
  const read = (p: string) => fs.promises.readFile(p, "utf8")
  return { passwd: await read(files.passwd).catch(() => ""), group: await read(files.group).catch(() => ""), shadow: await read(files.shadow).catch(() => null) }
}

// ---------------------------------------------------------------------------------------------------------------
// crypt(3) through python3 or perl

/** The python side: crypt(3) from libcrypt.so.1 (libxcrypt) with ctypes; the crypt module (Python ≤ 3.12) if not. */
const PY = [
  "import sys",
  "d=sys.stdin.buffer.read().split(b'\\0')",
  "h,p=d[0],d[1]",
  "r=b''",
  "try:",
  " import ctypes",
  " l=ctypes.CDLL('libcrypt.so.1');l.crypt.restype=ctypes.c_char_p;l.crypt.argtypes=[ctypes.c_char_p,ctypes.c_char_p]",
  " r=l.crypt(p,h) or b''",
  "except OSError:",
  " import warnings;warnings.simplefilter('ignore');import crypt",
  " r=(crypt.crypt(p.decode('utf-8','surrogateescape'),h.decode()) or '').encode('utf-8','surrogateescape')",
  "sys.stdout.buffer.write(r)",
].join("\n")
const PL = 'local $/="\\0"; my $h=<STDIN>; my $p=<STDIN>; chop $h; chop $p; my $r=crypt($p,$h); print(defined $r ? $r : "")'

export interface CryptMethod { name: "python3" | "perl"; cmd: string; args: string[] }
export const CRYPT_METHODS: readonly CryptMethod[] = [
  { name: "python3", cmd: "python3", args: ["-I", "-S", "-c", PY] },
  { name: "perl", cmd: "perl", args: ["-e", PL] },
]
const CHILD_ENV = { PATH: "/usr/local/bin:/usr/bin:/bin", LC_ALL: "C" } as unknown as NodeJS.ProcessEnv

/**
 * crypt(password, setting) with one method. The password goes on stdin and the buffer written is zeroed afterwards.
 * Rejects when the program is missing (ENOENT) or fails.
 */
export function cryptWith(m: CryptMethod, password: Buffer, setting: string, timeoutMs = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(m.cmd, m.args, { env: CHILD_ENV, stdio: ["pipe", "pipe", "pipe"] })
    const out: Buffer[] = []
    let size = 0
    let err = ""
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs)
    child.stdout.on("data", (c: Buffer) => {
      size += c.length
      if (size <= 1024) out.push(c)
    })
    child.stderr.on("data", (c: Buffer) => { if (err.length < 2000) err += c.toString("utf8") })
    child.on("error", (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      if (code !== 0) reject(new Error(`${m.name} terminó con ${code}: ${err.trim().split("\n").pop() ?? ""}`))
      else resolve(Buffer.concat(out).toString("utf8"))
    })
    const input = Buffer.concat([Buffer.from(`${setting}\0`, "utf8"), password, Buffer.from([0])])
    child.stdin.on("error", () => undefined)
    child.stdin.end(input, () => input.fill(0))
  })
}

/** Known vectors (crypt(3) of "relay-manager"): proves the method computes the same hashes as the system. */
const SELF_TEST: Record<string, { setting: string; hash: string }> = {
  "6": { setting: "$6$rmselftest$", hash: "$6$rmselftest$LuWPXuJ9sQU5zzBWhEFcWNbijI14/mz0TKxRfwTd/WoyKtH5Zh2EZPmVQzrr2Fecl54jDg06Lb/vDH1oNyoLR0" },
  "5": { setting: "$5$rmselftest$", hash: "$5$rmselftest$em28nAIgdd7B5LJwZ4oZHI9yYGqTHJnV9IbrXCVheq5" },
  "y": { setting: "$y$j9T$HdlczXsPYmBhMirrKsue1/", hash: "$y$j9T$HdlczXsPYmBhMirrKsue1/$hHikPP1lpIbUVHvDXaCAI0KkFk5MRhO7QC7tKKBgKX2" },
}

export interface Crypter {
  /** The method that passed the self-test ("python3"/"perl"), or why none works. */
  method(): Promise<{ name: string | null; error: string | null }>
  crypt(password: Buffer, setting: string): Promise<string>
}

/** Picks the first method that passes the self-test for the hash family of `family` ("y", "6", "5"…). */
export function createCrypter(methods: readonly CryptMethod[] = CRYPT_METHODS): Crypter {
  const chosen = new Map<string, Promise<{ m: CryptMethod | null; error: string | null }>>()
  function pick(family: string) {
    const key = SELF_TEST[family] ? family : "6"
    let p = chosen.get(key)
    if (!p) {
      p = (async () => {
        const errors: string[] = []
        for (const m of methods) {
          const v = SELF_TEST[key]
          try {
            const got = await cryptWith(m, Buffer.from("relay-manager"), v.setting)
            if (got === v.hash) return { m, error: null }
            errors.push(`${m.name}: resultado distinto`)
          } catch (e) {
            const code = (e as NodeJS.ErrnoException).code
            errors.push(code === "ENOENT" ? `${m.name}: no instalado` : `${m.name}: ${e instanceof Error ? e.message : String(e)}`)
          }
        }
        return { m: null, error: `No se pueden comprobar contraseñas (${errors.join("; ")}): instala python3 o perl.` }
      })()
      chosen.set(key, p)
      // A failure is not cached forever: python3 may be installed later.
      void p.then((r) => { if (!r.m) setTimeout(() => chosen.delete(key), 60_000).unref() })
    }
    return p
  }
  const familyOf = (setting: string) => /^\$([a-z0-9]+)\$/.exec(setting)?.[1] ?? "6"
  return {
    async method() {
      const r = await pick("6")
      return { name: r.m?.name ?? null, error: r.error }
    },
    async crypt(password, setting) {
      const r = await pick(familyOf(setting))
      if (!r.m) throw new Error(r.error ?? "sin método")
      return cryptWith(r.m, password, setting)
    },
  }
}

/** Constant-time equality of two strings of possibly different lengths. */
export function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest()
  const hb = crypto.createHash("sha256").update(b).digest()
  return crypto.timingSafeEqual(ha, hb) && a.length === b.length
}

// ---------------------------------------------------------------------------------------------------------------
// Failed attempts

export interface LimiterState { fails: number[]; lockedUntil: number }
export interface AttemptLimiterOptions { file: string | null; maxFails?: number; windowMs?: number; lockMs?: number; now?: () => number }

/**
 * At most `maxFails` wrong passwords in `windowMs`; then everything is refused for `lockMs`. The state is a small JSON
 * file in the helper's private state directory (0600), so a restart (or the next socket activation) keeps it.
 */
export class AttemptLimiter {
  private readonly max: number
  private readonly windowMs: number
  private readonly lockMs: number
  private readonly now: () => number
  private mem: LimiterState = { fails: [], lockedUntil: 0 }
  constructor(private readonly o: AttemptLimiterOptions) {
    this.max = o.maxFails ?? 5
    this.windowMs = o.windowMs ?? 10 * 60_000
    this.lockMs = o.lockMs ?? 10 * 60_000
    this.now = o.now ?? (() => Date.now())
  }

  private load(): LimiterState {
    if (!this.o.file) return this.mem
    try {
      const j = JSON.parse(fs.readFileSync(this.o.file, "utf8")) as Partial<LimiterState>
      return { fails: Array.isArray(j.fails) ? j.fails.filter((n): n is number => typeof n === "number") : [], lockedUntil: typeof j.lockedUntil === "number" ? j.lockedUntil : 0 }
    } catch {
      return { fails: [], lockedUntil: 0 }
    }
  }

  private save(s: LimiterState): void {
    this.mem = s
    if (!this.o.file) return
    try {
      fs.mkdirSync(path.dirname(this.o.file), { recursive: true, mode: 0o700 })
      const tmp = `${this.o.file}.${process.pid}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 })
      fs.renameSync(tmp, this.o.file)
    } catch {
      // Keeps the in-memory state: the limit still applies while this process lives.
    }
  }

  /** Locked now? (with when it ends). */
  status(): { locked: boolean; until: number } {
    const s = this.load()
    const t = this.now()
    return { locked: s.lockedUntil > t, until: s.lockedUntil }
  }

  /** Records a wrong password; returns whether that locked the account. */
  fail(): boolean {
    const t = this.now()
    const s = this.load()
    const fails = [...s.fails.filter((f) => t - f < this.windowMs), t]
    if (fails.length >= this.max) {
      this.save({ fails: [], lockedUntil: t + this.lockMs })
      return true
    }
    this.save({ fails, lockedUntil: s.lockedUntil })
    return false
  }

  success(): void {
    const s = this.load()
    if (s.fails.length || s.lockedUntil) this.save({ fails: [], lockedUntil: 0 })
  }
}

export type VerifyOutcome =
  | { ok: true }
  | { ok: false; code: "ACCOUNT"; message: string }
  | { ok: false; code: "LOCKED"; message: string }
  | { ok: false; code: "AUTH"; message: string }

const minutesUntil = (until: number, now: number) => Math.max(1, Math.ceil((until - now) / 60_000))

/**
 * Checks the password of the configured account. The caller zeroes `password` afterwards. Never logs or keeps it.
 */
export async function verifyPassword(o: {
  user: string; sudoGroups: readonly string[]; password: Buffer; files: AccountFiles; crypter: Crypter; limiter: AttemptLimiter; now?: () => number
}): Promise<VerifyOutcome> {
  const now = o.now ?? (() => Date.now())
  const lock = o.limiter.status()
  if (lock.locked) {
    return { ok: false, code: "LOCKED", message: `Demasiados intentos con una contraseña incorrecta: espera ${minutesUntil(lock.until, now())} min.` }
  }
  const st = accountStatus(o.user, o.sudoGroups, await readAccountTexts(o.files), now())
  if (st.state !== "ok" || !st.hash) return { ok: false, code: "ACCOUNT", message: st.message ?? "Cuenta no válida." }
  let got: string
  try {
    got = await o.crypter.crypt(o.password, st.hash)
  } catch (e) {
    return { ok: false, code: "ACCOUNT", message: e instanceof Error ? e.message : String(e) }
  }
  if (got.length > 0 && !got.startsWith("*") && safeEqual(got, st.hash)) {
    o.limiter.success()
    return { ok: true }
  }
  const locked = o.limiter.fail()
  if (locked) {
    const s = o.limiter.status()
    return { ok: false, code: "LOCKED", message: `Contraseña incorrecta. Demasiados intentos: espera ${minutesUntil(s.until, now())} min.` }
  }
  return { ok: false, code: "AUTH", message: `Contraseña incorrecta para «${o.user}».` }
}
