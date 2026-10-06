import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { accountStatus, AttemptLimiter, createCrypter, CRYPT_METHODS, cryptWith, safeEqual, verifyPassword, type AccountFiles } from "./auth"

/** A shadow hash made by the system's crypt(3) (python3 + libcrypt via ctypes, as the helper does). */
function mkhash(password: string, prefix: "$y$" | "$6$" | "$5$"): string {
  const py = [
    "import ctypes,sys",
    "l=ctypes.CDLL('libcrypt.so.1')",
    "l.crypt_gensalt.restype=ctypes.c_char_p;l.crypt_gensalt.argtypes=[ctypes.c_char_p,ctypes.c_ulong,ctypes.c_char_p,ctypes.c_int]",
    "l.crypt.restype=ctypes.c_char_p;l.crypt.argtypes=[ctypes.c_char_p,ctypes.c_char_p]",
    "s=l.crypt_gensalt(sys.argv[1].encode(),0,None,0)",
    "sys.stdout.write(l.crypt(sys.stdin.buffer.read(),s).decode())",
  ].join("\n")
  const r = spawnSync("python3", ["-c", py, prefix], { input: password, encoding: "utf8" })
  if (r.status !== 0 || !r.stdout.startsWith(prefix)) throw new Error(`python3 no ha generado el hash: ${r.stderr}`)
  return r.stdout
}

const PASSWD = [
  "root:x:0:0:root:/root:/bin/bash",
  "ana:x:1000:1000:Ana:/home/ana:/bin/bash",
  "luis:x:1001:1001:Luis:/home/luis:/bin/bash",
  "rueda:x:1002:27:Rueda:/home/rueda:/bin/bash",
  "relay-manager:x:998:998::/var/lib/relay-manager:/usr/sbin/nologin",
].join("\n")
const GROUP = ["root:x:0:", "sudo:x:27:ana", "ana:x:1000:", "luis:x:1001:", "wheel:x:10:", "relay-manager:x:998:"].join("\n")
const shadowOf = (lines: Record<string, string>) => Object.entries(lines).map(([u, h]) => `${u}:${h}:19800:0:99999:7:::`).join("\n")
const GROUPS = ["sudo", "wheel", "admin"]

describe("accountStatus: the configured sudo user", () => {
  const texts = (shadow: Record<string, string> | null) => ({ passwd: PASSWD, group: GROUP, shadow: shadow ? shadowOf(shadow) : null })
  it("a sudo member with a password is fine (by member list or by primary group)", () => {
    expect(accountStatus("ana", GROUPS, texts({ ana: "$y$j9T$abc$def" }))).toMatchObject({ state: "ok", hash: "$y$j9T$abc$def" })
    expect(accountStatus("rueda", GROUPS, texts({ rueda: "$6$x$y" }))).toMatchObject({ state: "ok" })
  })
  it("a user outside the sudo groups is refused, whatever its password", () => {
    expect(accountStatus("luis", GROUPS, texts({ luis: "$6$x$y" }))).toMatchObject({ state: "not-sudo", message: expect.stringMatching(/no es administrador/) })
    expect(accountStatus("relay-manager", GROUPS, texts({ "relay-manager": "!" })).state).toBe("not-sudo")
  })
  it("unknown, locked, empty, expired and unsupported accounts", () => {
    expect(accountStatus("nadie", GROUPS, texts({})).state).toBe("no-user")
    expect(accountStatus("ana;rm", GROUPS, texts({})).state).toBe("no-user")
    expect(accountStatus("ana", GROUPS, texts({ ana: "!$6$x$y" })).state).toBe("locked")
    expect(accountStatus("ana", GROUPS, texts({ ana: "*" })).state).toBe("locked")
    expect(accountStatus("ana", GROUPS, texts({ ana: "" })).state).toBe("no-password")
    expect(accountStatus("ana", GROUPS, texts({ ana: "$1$md5$x" })).state).toBe("unsupported-hash")
    expect(accountStatus("ana", GROUPS, texts({ ana: "abcDESxyz" })).state).toBe("unsupported-hash")
    const expired = { passwd: PASSWD, group: GROUP, shadow: "ana:$6$x$y:19800:0:99999:7::19000:" }
    expect(accountStatus("ana", GROUPS, expired, Date.UTC(2026, 0, 1)).state).toBe("locked")
    expect(accountStatus("ana", GROUPS, texts(null)).state).toBe("unreadable")
  })
  it("root without a usable password: a clear message pointing to a sudo user", () => {
    for (const h of ["!", "*", "", "!$6$x$y"]) {
      const s = accountStatus("root", GROUPS, texts({ root: h }))
      expect(s.state === "locked" || s.state === "no-password").toBe(true)
      expect(s.message).toMatch(/^La cuenta root no tiene contraseña/)
      expect(s.message).toMatch(/--sudo-user/)
    }
    expect(accountStatus("root", GROUPS, texts({ root: "$y$j9T$a$b" })).state).toBe("ok")
  })
})

describe("password verification against generated shadow lines", () => {
  let dir: string
  let files: AccountFiles
  let t = Date.UTC(2026, 9, 5, 10)
  const now = () => t
  const crypter = createCrypter()
  const write = (shadow: Record<string, string>) => fs.writeFileSync(files.shadow, shadowOf(shadow))
  const verify = (user: string, password: string, limiter = new AttemptLimiter({ file: path.join(dir, "intentos.json"), now })) =>
    verifyPassword({ user, sudoGroups: GROUPS, password: Buffer.from(password), files, crypter, limiter, now })

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "rm-auth-"))
    files = { passwd: path.join(dir, "passwd"), group: path.join(dir, "group"), shadow: path.join(dir, "shadow") }
    fs.writeFileSync(files.passwd, PASSWD)
    fs.writeFileSync(files.group, GROUP)
    t = Date.UTC(2026, 9, 5, 10)
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it.each([["$y$"], ["$6$"], ["$5$"]] as const)("%s: the right password passes, a wrong one does not", async (prefix) => {
    write({ ana: mkhash("contraseña buena ñ", prefix), root: "!" })
    expect(await verify("ana", "contraseña buena ñ")).toEqual({ ok: true })
    expect(await verify("ana", "contraseña mala")).toMatchObject({ ok: false, code: "AUTH", message: "Contraseña incorrecta para «ana»." })
    expect(await verify("ana", "")).toMatchObject({ ok: false, code: "AUTH" })
  })

  it("a sudo-less user, root without password and a locked account never get to the password check", async () => {
    write({ ana: `!${mkhash("x", "$6$")}`, luis: mkhash("luis-pw", "$6$"), root: "*" })
    expect(await verify("luis", "luis-pw")).toMatchObject({ ok: false, code: "ACCOUNT", message: expect.stringMatching(/no es administrador/) })
    expect(await verify("root", "x")).toMatchObject({ ok: false, code: "ACCOUNT", message: expect.stringMatching(/^La cuenta root no tiene contraseña/) })
    expect(await verify("ana", "x")).toMatchObject({ ok: false, code: "ACCOUNT", message: expect.stringMatching(/bloqueada/) })
  })

  it("root with a password (Debian when the installer set one) is accepted", async () => {
    write({ root: mkhash("debian-root", "$y$") })
    expect(await verify("root", "debian-root")).toEqual({ ok: true })
  })

  it("5 wrong passwords in 10 minutes lock for 10 minutes (even the right one), persisted across restarts", async () => {
    write({ ana: mkhash("buena", "$6$") })
    for (let i = 0; i < 4; i++) expect(await verify("ana", `mala${i}`)).toMatchObject({ code: "AUTH" })
    expect(await verify("ana", "mala5")).toMatchObject({ code: "LOCKED", message: expect.stringMatching(/espera 10 min/) })
    // A new limiter instance (the helper restarted by socket activation) reads the same state.
    expect(await verify("ana", "buena", new AttemptLimiter({ file: path.join(dir, "intentos.json"), now }))).toMatchObject({ code: "LOCKED" })
    expect(fs.statSync(path.join(dir, "intentos.json")).mode & 0o777).toBe(0o600)
    t += 10 * 60_000 + 1
    expect(await verify("ana", "buena")).toEqual({ ok: true })
    // A success resets the count.
    for (let i = 0; i < 4; i++) await verify("ana", "mala")
    expect(await verify("ana", "buena")).toEqual({ ok: true })
    expect(await verify("ana", "mala")).toMatchObject({ code: "AUTH" })
  })

  it("old failures fall out of the window", () => {
    const l = new AttemptLimiter({ file: null, now })
    for (let i = 0; i < 4; i++) l.fail()
    t += 11 * 60_000
    expect(l.fail()).toBe(false)
    expect(l.status().locked).toBe(false)
  })
})

describe("crypt(3) methods", () => {
  it("python3 and perl compute the same yescrypt, sha512 and sha256 hashes as the system", async () => {
    for (const prefix of ["$y$", "$6$", "$5$"] as const) {
      const h = mkhash("relay", prefix)
      for (const m of CRYPT_METHODS) expect(await cryptWith(m, Buffer.from("relay"), h), `${m.name} ${prefix}`).toBe(h)
    }
  })
  it("the password is read from stdin: a NUL ends it, newlines and quotes are just characters", async () => {
    const h = mkhash("a'b\"c\nd", "$6$")
    expect(await cryptWith(CRYPT_METHODS[0], Buffer.from("a'b\"c\nd"), h)).toBe(h)
    expect(await cryptWith(CRYPT_METHODS[1], Buffer.from("a'b\"c\nd"), h)).toBe(h)
  })
  it("picks the first method that passes the self-test; a missing program falls back to the next", async () => {
    expect((await createCrypter().method()).name).toBe("python3")
    const missing = { name: "python3" as const, cmd: "/nonexistent/python3", args: [] }
    const c = createCrypter([missing, CRYPT_METHODS[1]])
    expect(await c.method()).toEqual({ name: "perl", error: null })
    const none = createCrypter([missing])
    expect((await none.method()).error).toMatch(/python3: no instalado/)
  })
  it("constant-time comparison of strings of any length", () => {
    expect(safeEqual("abc", "abc")).toBe(true)
    expect(safeEqual("abc", "abd")).toBe(false)
    expect(safeEqual("abc", "abcd")).toBe(false)
    expect(safeEqual("", "")).toBe(true)
  })
})
