// The root helper over a real unix socket, run as the current user with injected account files (as root it would only
// read /etc/passwd, /etc/group and /etc/shadow). The bundle tests run it as root under systemd.
import { spawnSync } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createHelperClient, HelperUnavailable } from "@/server/files/copy/helper-client"
import { buildPolicy } from "@/server/files/copy/policy"
import { AttemptLimiter, createCrypter } from "./auth"
import { createRootCopyServer, loadHelperConfig, type HelperConfig } from "./server"

function mkhash(password: string): string {
  const py = "import ctypes,sys\nl=ctypes.CDLL('libcrypt.so.1')\nl.crypt_gensalt.restype=ctypes.c_char_p\nl.crypt.restype=ctypes.c_char_p\nsys.stdout.write(l.crypt(sys.stdin.buffer.read(),l.crypt_gensalt(b'$y$',0,None,0)).decode())"
  return spawnSync("python3", ["-c", py], { input: password, encoding: "utf8" }).stdout
}
const sha = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex")
async function* chunks(b: Buffer, size = 65536) {
  for (let i = 0; i < b.length; i += size) yield b.subarray(i, i + size)
}
const PW = "clave-de-ana-1"
const HASH = mkhash(PW)

describe("relay-manager-rootcopy (helper) over a unix socket", () => {
  let tmp: string
  let media: string
  let other: string
  let sock: string
  let server: ReturnType<typeof createRootCopyServer>
  const logs: string[] = []

  async function start(over: Partial<HelperConfig> = {}): Promise<void> {
    const config: HelperConfig = { enabled: true, sudoUser: "ana", sudoGroups: ["sudo"], writePaths: [media], policy: buildPolicy(["/"], [], []), ...over }
    server = createRootCopyServer({
      config, version: "test", failDelayMs: 0, log: (m) => logs.push(m), crypter: createCrypter(),
      files: { passwd: path.join(tmp, "passwd"), group: path.join(tmp, "group"), shadow: path.join(tmp, "shadow") },
      limiter: new AttemptLimiter({ file: path.join(tmp, "state", "intentos.json") }),
    })
    await new Promise<void>((r) => server.listen(sock, r))
  }

  beforeEach(async () => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rm-helper-")))
    media = path.join(tmp, "media")
    other = path.join(tmp, "otra")
    fs.mkdirSync(path.join(media, "USB"), { recursive: true })
    fs.mkdirSync(other)
    sock = path.join(tmp, "rootcopy.sock")
    fs.writeFileSync(path.join(tmp, "passwd"), "ana:x:1000:1000::/home/ana:/bin/bash\nluis:x:1001:1001::/home/luis:/bin/bash\n")
    fs.writeFileSync(path.join(tmp, "group"), "sudo:x:27:ana\n")
    fs.writeFileSync(path.join(tmp, "shadow"), `ana:${HASH}:19800:0:99999:7:::\nluis:${HASH}:19800:0:99999:7:::\n`)
    logs.length = 0
    await start()
  })
  afterEach(async () => {
    await new Promise((r) => server.close(r))
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it("ping: who authenticates, how, and where it writes; no password needed", async () => {
    const r = await createHelperClient(sock).ping()
    expect(r).toMatchObject({ op: "ping", version: "test", enabled: true, user: "ana", account: "ok", accountMessage: null, method: "python3", writePaths: [media] })
  })

  it("copies as the configured user: streamed bytes, temp + rename, 0644, owner of the folder, sha256", async () => {
    const data = crypto.randomBytes(3 * 1024 * 1024 + 17)
    const progress: number[] = []
    let verifying = false
    const r = await createHelperClient(sock).copy(
      { password: PW, dir: path.join(media, "USB"), name: "imagen.bin", size: data.length, conflict: "keep" },
      { size: data.length, chunks: chunks(data), signal: new AbortController().signal, onProgress: (n) => progress.push(n), onVerifying: () => { verifying = true } },
    )
    expect(r).toMatchObject({ op: "copy", name: "imagen.bin", skipped: false, replaced: false, sha256: sha(data), size: data.length })
    const f = path.join(media, "USB", "imagen.bin")
    expect(sha(fs.readFileSync(f))).toBe(sha(data))
    expect(fs.statSync(f).mode & 0o777).toBe(0o644)
    expect(fs.statSync(f).uid).toBe(fs.statSync(path.join(media, "USB")).uid)
    expect(progress.at(-1)).toBe(data.length)
    expect(verifying).toBe(true)
    expect(fs.readdirSync(path.join(media, "USB"))).toEqual(["imagen.bin"])
    expect(logs.join("\n")).not.toContain(PW)
  })

  it("Omitir answers before any byte is sent; Reemplazar replaces", async () => {
    fs.writeFileSync(path.join(media, "USB", "a.txt"), "viejo")
    const c = createHelperClient(sock)
    let ready = false
    const skip = await c.copy({ password: PW, dir: path.join(media, "USB"), name: "a.txt", size: 5, conflict: "skip" },
      { size: 5, chunks: chunks(Buffer.from("nuevo")), signal: new AbortController().signal, onReady: () => { ready = true } })
    expect(skip).toMatchObject({ skipped: true, name: null })
    expect(ready).toBe(false)
    const rep = await c.copy({ password: PW, dir: path.join(media, "USB"), name: "a.txt", size: 5, conflict: "replace" },
      { size: 5, chunks: chunks(Buffer.from("nuevo")), signal: new AbortController().signal })
    expect(rep).toMatchObject({ replaced: true, name: "a.txt" })
    expect(fs.readFileSync(path.join(media, "USB", "a.txt"), "utf8")).toBe("nuevo")
  })

  it("a wrong password is refused and nothing is written; 5 lock the account", async () => {
    const c = createHelperClient(sock)
    const attempt = () => c.copy({ password: "mala", dir: path.join(media, "USB"), name: "x", size: 1, conflict: "keep" },
      { size: 1, chunks: chunks(Buffer.from("x")), signal: new AbortController().signal })
    for (let i = 0; i < 4; i++) await expect(attempt()).rejects.toMatchObject({ code: "AUTH", message: "Contraseña incorrecta para «ana»." })
    await expect(attempt()).rejects.toMatchObject({ code: "LOCKED" })
    await expect(c.probe({ password: PW, dir: media, list: true, hidden: false })).rejects.toMatchObject({ code: "LOCKED" })
    expect(fs.readdirSync(path.join(media, "USB"))).toEqual([])
    expect(logs.join("\n")).not.toContain("mala")
  })

  it("a user outside the sudo groups is refused even with its right password; a client-sent user is ignored", async () => {
    await new Promise((r) => server.close(r))
    await start({ sudoUser: "luis" })
    const c = createHelperClient(sock)
    expect((await c.ping()).account).toBe("not-sudo")
    await expect(c.probe({ password: PW, dir: media, list: false, hidden: false })).rejects.toMatchObject({ code: "ACCOUNT", message: expect.stringMatching(/no es administrador/) })
    // A raw request naming another user: the helper still authenticates "luis".
    const reply = await rawRequest(sock, JSON.stringify({ v: 1, op: "probe", user: "ana", password: PW, dir: media }))
    expect(reply).toMatchObject({ type: "error", code: "ACCOUNT" })
  })

  it("re-validates the destination: outside RM_COPY_ROOT_PATHS, system folders, links and missing folders", async () => {
    const c = createHelperClient(sock)
    await expect(c.probe({ password: PW, dir: other, list: false, hidden: false })).rejects.toMatchObject({ code: "DENIED", message: expect.stringMatching(/RM_COPY_ROOT_PATHS/) })
    await expect(c.probe({ password: PW, dir: "/etc", list: false, hidden: false })).rejects.toMatchObject({ code: "DENIED" })
    fs.symlinkSync(other, path.join(media, "enlace"))
    await expect(c.probe({ password: PW, dir: path.join(media, "enlace"), list: false, hidden: false })).rejects.toMatchObject({ code: "DENIED" })
    await expect(c.probe({ password: PW, dir: path.join(media, "nada"), list: false, hidden: false })).rejects.toMatchObject({ code: "NOT_FOUND" })
    await expect(c.probe({ password: PW, dir: "relativa", list: false, hidden: false })).rejects.toMatchObject({ code: "INVALID" })
    await expect(c.mkdir({ password: PW, dir: media, name: "../fuera" })).rejects.toMatchObject({ code: "INVALID" })
  })

  it("probe lists folders; mkdir creates one owned like its parent", async () => {
    const c = createHelperClient(sock)
    expect(await c.mkdir({ password: PW, dir: path.join(media, "USB"), name: "fotos" })).toMatchObject({ real: path.join(media, "USB", "fotos") })
    const p = await c.probe({ password: PW, dir: path.join(media, "USB"), list: true, hidden: false })
    expect(p).toMatchObject({ real: path.join(media, "USB"), writable: true, folders: [{ name: "fotos", hidden: false, link: false }] })
  })

  it("cancelling (closing the connection) removes the temporary file", async () => {
    const big = crypto.randomBytes(8 * 1024 * 1024)
    const ac = new AbortController()
    const p = createHelperClient(sock).copy({ password: PW, dir: path.join(media, "USB"), name: "grande.bin", size: big.length, conflict: "keep" },
      { size: big.length, chunks: chunks(big, 64 * 1024), signal: ac.signal, onProgress: (n) => { if (n > 1024 * 1024) ac.abort() } })
    await expect(p).rejects.toMatchObject({ code: "CANCELED" })
    for (let i = 0; i < 50 && fs.readdirSync(path.join(media, "USB")).length; i++) await new Promise((r) => setTimeout(r, 20))
    expect(fs.readdirSync(path.join(media, "USB"))).toEqual([])
  })

  it("protocol: bad JSON, unknown op, other versions and oversized headers are refused", async () => {
    expect(await rawRequest(sock, "{no")).toMatchObject({ type: "error", code: "PROTOCOL" })
    expect(await rawRequest(sock, JSON.stringify({ v: 1, op: "rm", password: PW, dir: media, name: "x" }))).toMatchObject({ type: "error", code: "PROTOCOL" })
    expect(await rawRequest(sock, JSON.stringify({ v: 2, op: "ping" }))).toMatchObject({ type: "error", code: "PROTOCOL" })
    expect(await rawRequest(sock, JSON.stringify({ v: 1, op: "copy", password: PW, dir: media, name: "x", size: -1, conflict: "keep" }))).toMatchObject({ code: "PROTOCOL" })
    expect(await rawRequest(sock, "x".repeat(20_000))).toMatchObject({ type: "error", code: "PROTOCOL" })
  })

  it("disabled, or a missing configuration: everything but ping is refused", async () => {
    expect(loadHelperConfig(null).enabled).toBe(false)
    const cfg = loadHelperConfig("RM_SUDO_USER=ana\nRM_COPY_ROOT_PATHS=/media,/srv/usb\nRM_COPY_DENY=/srv/usb/no\nRM_COPY_SUDO_GROUPS=wheel\n")
    expect(cfg).toMatchObject({ enabled: true, sudoUser: "ana", sudoGroups: ["wheel"], writePaths: ["/media", "/srv/usb"] })
    expect(cfg.policy.deny).toContain("/srv/usb/no")
    expect(() => loadHelperConfig("RM_COPY_ROOT_PATHS=media")).toThrow(/RM_COPY_ROOT_PATHS/)
    await new Promise((r) => server.close(r))
    await start({ enabled: false })
    await expect(createHelperClient(sock).probe({ password: PW, dir: media, list: false, hidden: false })).rejects.toMatchObject({ code: "DISABLED" })
  })

  it("no helper listening: HelperUnavailable with a Spanish message", async () => {
    await expect(createHelperClient(path.join(tmp, "nada.sock")).ping()).rejects.toBeInstanceOf(HelperUnavailable)
  })
})

/** One raw header line; resolves with the first message. */
function rawRequest(sock: string, line: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const s = net.createConnection({ path: sock })
    let buf = ""
    s.on("connect", () => s.write(`${line}\n`))
    s.on("data", (c) => {
      buf += c.toString()
      const i = buf.indexOf("\n")
      if (i >= 0) {
        resolve(JSON.parse(buf.slice(0, i)) as Record<string, unknown>)
        s.destroy()
      }
    })
    s.on("error", reject)
    s.on("close", () => { if (!buf) reject(new Error("cerrada sin respuesta")) })
  })
}
