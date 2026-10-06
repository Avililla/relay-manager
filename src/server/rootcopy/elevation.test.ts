// The copy helper with elevation tokens, the read-only "list" and the mount/unmount relay to an in-process mount helper
// (fake sysfs and programs). Run as the current user with injected account files.
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { fakeHost, startMountHelper, type FakeHost } from "../../../test/helpers/fake-sysfs"
import { createHelperClient } from "@/server/files/copy/helper-client"
import { buildPolicy } from "@/server/files/copy/policy"
import { ELEVATION_TTL_MS } from "@/server/files/copy/protocol"
import { AttemptLimiter, createCrypter } from "./auth"
import { createRootCopyServer } from "./server"
import { TokenStore } from "./token"

function mkhash(password: string): string {
  const py = "import ctypes,sys\nl=ctypes.CDLL('libcrypt.so.1')\nl.crypt_gensalt.restype=ctypes.c_char_p\nl.crypt.restype=ctypes.c_char_p\nsys.stdout.write(l.crypt(sys.stdin.buffer.read(),l.crypt_gensalt(b'$6$',0,None,0)).decode())"
  return spawnSync("python3", ["-c", py], { input: password, encoding: "utf8" }).stdout
}
const PW = "clave-de-ana-2"
const HASH = mkhash(PW)
const S = { sid: "c".repeat(64), webUser: "u-admin" }

describe("copy helper: elevation, list and mounting", () => {
  let tmp: string
  let host: FakeHost
  let media: string
  let state: string
  let sock: string
  let msock: string
  let t = 0
  const logs: string[] = []
  let helper: ReturnType<typeof createRootCopyServer>
  let mounter: Awaited<ReturnType<typeof startMountHelper>>
  const c = () => createHelperClient(sock)

  async function startHelper(mountSocket: string | null) {
    helper = createRootCopyServer({
      config: { enabled: true, sudoUser: "ana", sudoGroups: ["sudo"], writePaths: [media], policy: buildPolicy(["/"], [], []) },
      files: { passwd: path.join(tmp, "passwd"), group: path.join(tmp, "group"), shadow: path.join(tmp, "shadow") },
      crypter: createCrypter(), limiter: new AttemptLimiter({ file: path.join(state, "intentos.json") }), version: "test", failDelayMs: 0,
      log: (m) => logs.push(m), mountSocket, listDeny: [state],
      tokens: new TokenStore({ keyFile: path.join(state, "token.key"), revokedFile: path.join(state, "revoked.json"), now: () => t }),
    })
    await new Promise<void>((r) => helper.listen(sock, r))
  }

  beforeEach(async () => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rm-elev-")))
    host = fakeHost(tmp)
    media = host.media
    state = path.join(tmp, "rc-state")
    fs.mkdirSync(state)
    fs.writeFileSync(path.join(tmp, "shadow"), `ana:${HASH}:19800:0:99999:7:::\n`)
    sock = path.join(tmp, "rootcopy.sock")
    msock = path.join(tmp, "rootmount.sock")
    t = Date.now()
    logs.length = 0
    mounter = await startMountHelper(host, msock)
    await startHelper(msock)
  })
  afterEach(async () => {
    await new Promise((r) => helper.close(r))
    await new Promise((r) => mounter.close(r))
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it("a password with `issue` returns a token that then works alone, for that session only, until it expires", async () => {
    const p = await c().probe({ password: PW, session: S, issue: true, dir: media, list: false, hidden: false })
    expect(p.token?.expiresAt).toBe(t + ELEVATION_TTL_MS)
    const token = p.token?.value ?? ""
    expect(await c().list({ token, session: S, dir: media, hidden: false })).toMatchObject({ op: "list", real: media })
    expect(await c().mkdir({ token, session: S, dir: media, name: "nueva" })).toMatchObject({ real: path.join(media, "nueva") })
    // No token is issued without asking, nor from a token.
    expect((await c().probe({ password: PW, dir: media, list: false, hidden: false })).token).toBeUndefined()
    expect((await c().probe({ token, session: S, dir: media, list: false, hidden: false })).token).toBeUndefined()
    // Another session, another web user, no session.
    await expect(c().list({ token, session: { ...S, sid: "d".repeat(64) }, dir: media, hidden: false })).rejects.toMatchObject({ code: "TOKEN" })
    await expect(c().list({ token, session: { ...S, webUser: "u-luis" }, dir: media, hidden: false })).rejects.toMatchObject({ code: "TOKEN" })
    await expect(c().list({ token, dir: media, hidden: false })).rejects.toMatchObject({ code: "PROTOCOL" })
    // Expired.
    t += ELEVATION_TTL_MS
    await expect(c().list({ token, session: S, dir: media, hidden: false })).rejects.toMatchObject({ code: "TOKEN", message: expect.stringMatching(/caducado.*contraseña de ana/) })
    expect(logs.join("\n")).not.toContain(PW)
    expect(logs.join("\n")).not.toContain(token)
  })

  it("«Olvidar permisos» revokes the token; bad tokens never count as wrong passwords; a wrong password gets no token", async () => {
    const token = (await c().probe({ password: PW, session: S, issue: true, dir: media, list: false, hidden: false })).token?.value ?? ""
    expect(await c().revoke(token)).toEqual({ type: "result", op: "revoke" })
    await expect(c().probe({ token, session: S, dir: media, list: false, hidden: false })).rejects.toMatchObject({ code: "TOKEN", message: expect.stringMatching(/olvidado/) })
    for (let i = 0; i < 8; i++) await expect(c().probe({ token: `${"x".repeat(40)}.${"y".repeat(43)}`, session: S, dir: media, list: false, hidden: false })).rejects.toMatchObject({ code: "TOKEN" })
    await expect(c().probe({ password: "mala", session: S, issue: true, dir: media, list: false, hidden: false })).rejects.toMatchObject({ code: "AUTH" })
    const ok = await c().probe({ password: PW, session: S, issue: true, dir: media, list: false, hidden: false })
    expect(ok.token).toBeDefined()
  })

  it("list: folders and files with metadata only (never opens them), anywhere browsable; never /proc nor the helpers' state", async () => {
    const other = path.join(tmp, "otra")
    fs.mkdirSync(path.join(other, "sub"), { recursive: true })
    fs.writeFileSync(path.join(other, "secreto.txt"), "no se lee")
    fs.chmodSync(path.join(other, "secreto.txt"), 0o000)
    spawnSync("mkfifo", [path.join(other, "tuberia")])
    fs.symlinkSync("/etc", path.join(other, "enlace"))
    fs.writeFileSync(path.join(other, ".oculto"), "x")
    const auth = { password: PW }
    const r = await c().list({ ...auth, dir: other, hidden: false })
    expect(r.entries.map((e) => [e.name, e.kind, e.link])).toEqual([["enlace", "dir", true], ["sub", "dir", false], ["secreto.txt", "file", false], ["tuberia", "other", false]])
    expect(r.entries.find((e) => e.name === "secreto.txt")).toMatchObject({ size: 9, hidden: false })
    expect(r.writable).toBe(false) // outside RM_COPY_ROOT_PATHS: listed, not writable
    expect((await c().list({ ...auth, dir: other, hidden: true })).entries.map((e) => e.name)).toContain(".oculto")
    expect((await c().list({ ...auth, dir: media, hidden: false })).writable).toBe(true)
    expect((await c().list({ ...auth, dir: "/etc", hidden: false })).entries.length).toBeGreaterThan(0)
    await expect(c().list({ ...auth, dir: "/proc", hidden: false })).rejects.toMatchObject({ code: "DENIED" })
    await expect(c().list({ ...auth, dir: "/sys/class", hidden: false })).rejects.toMatchObject({ code: "DENIED" })
    await expect(c().list({ ...auth, dir: state, hidden: false })).rejects.toMatchObject({ code: "DENIED" })
    fs.symlinkSync(state, path.join(media, "estado"))
    await expect(c().list({ ...auth, dir: path.join(media, "estado"), hidden: false })).rejects.toMatchObject({ code: "DENIED" })
    await expect(c().list({ ...auth, dir: path.join(tmp, "nada"), hidden: false })).rejects.toMatchObject({ code: "NOT_FOUND" })
    // Listing is no license to write: copying into /etc is still refused.
    await expect(c().probe({ ...auth, dir: "/etc", list: false, hidden: false })).rejects.toMatchObject({ code: "DENIED" })
    fs.chmodSync(path.join(other, "secreto.txt"), 0o600)
  })

  it("mount and unmount are relayed (with a token) and checked again by the mount helper", async () => {
    expect((await c().ping()).mount).toEqual({ available: true, problem: null })
    const m = await c().mount({ password: PW, session: S, issue: true, device: "/dev/sdb1" })
    expect(m).toMatchObject({ op: "mount", device: "/dev/sdb1", mountPoint: path.join(media, "ana", "MI_USB"), fsType: "vfat" })
    const token = m.token?.value ?? ""
    await expect(c().mount({ token, session: S, device: "/dev/sda1" })).rejects.toMatchObject({ code: "DEVICE" })
    await expect(c().mount({ token, session: S, device: "/dev/sdd1" })).rejects.toMatchObject({ code: "DEVICE", message: expect.stringMatching(/disco del sistema/) })
    await expect(c().mount({ token, session: { ...S, sid: "e".repeat(64) }, device: "/dev/sdb2" })).rejects.toMatchObject({ code: "TOKEN" })
    expect(await c().unmount({ token, session: S, mountPoint: m.mountPoint })).toMatchObject({ op: "unmount", removedDir: true })
    expect(host.calls.filter((x) => x.op === "mount")).toHaveLength(1)
    // A wrong password never reaches the mount helper.
    await expect(c().mount({ password: "mala", device: "/dev/sdb1" })).rejects.toMatchObject({ code: "AUTH" })
    expect(host.calls.filter((x) => x.op === "mount")).toHaveLength(1)
  })

  it("without the mount helper: ping says so and mounting answers NO_MOUNT", async () => {
    await new Promise((r) => helper.close(r))
    await startHelper(path.join(tmp, "no-existe.sock"))
    expect((await c().ping()).mount).toMatchObject({ available: false, problem: expect.stringMatching(/rootmount/) })
    await expect(c().mount({ password: PW, device: "/dev/sdb1" })).rejects.toMatchObject({ code: "NO_MOUNT" })
  })
})
