// The copy service's elevation of a browser session (5 min, server-side token, bound to the session), browsing folders
// the service cannot read, «Montar» / «Expulsar», with a fake root helper that records how each request authenticated.
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { COPY_ELEVATION_TTL_MS, type FilesRootId } from "@/lib/contracts/files"
import { createNullLogger } from "@/server/log"
import type { AuthUser } from "@/server/runtime/types"
import { fakeAudit, fakeBus, testConfig } from "../../../../test/helpers"
import { makeFakeSysfs, mountLine } from "../../../../test/helpers/fake-sysfs"
import type { HelperClient } from "./helper-client"
import type { HelperAuth, HelperRequest, IssuedToken, PingResult } from "./protocol"
import { CopyError } from "./safe-dest"
import { createCopyService, sessionIdOf, type CopyService, type CopyViewer } from "./service"

const PW = "sudo-de-ana"
const admin: AuthUser = { id: "u-admin", username: "admin", name: "Admin", isAdmin: true, roleIds: [], mustChangePassword: false, sessionVersion: 1 }
const ana: AuthUser = { ...admin, id: "u-ana", username: "ana", isAdmin: false }
const viewer = (user = admin, loginAt = 1): CopyViewer => ({ user, ip: "10.0.0.5", sid: sessionIdOf({ user, sv: 1, loginAt }) })

interface Call { op: string; auth: HelperAuth; req: Record<string, unknown> }

function fakeHelper(t: () => number, mediaDir: string) {
  const calls: Call[] = []
  const valid = new Map<string, { sid: string; wu: string; exp: number }>()
  let n = 0
  const authOf = (r: Record<string, unknown>): HelperAuth => ({ password: r.password as string | undefined, token: r.token as string | undefined, session: r.session as HelperAuth["session"], issue: r.issue as boolean | undefined })
  function check(op: string, r: Record<string, unknown>): IssuedToken | undefined {
    calls.push({ op, auth: authOf(r), req: r })
    if (r.token !== undefined) {
      const v = valid.get(r.token as string)
      const s = r.session as { sid: string; webUser: string } | undefined
      if (!v || v.exp <= t() || !s || s.sid !== v.sid || s.webUser !== v.wu) throw new CopyError("TOKEN", "Los permisos de administrador han caducado. Escribe la contraseña de ana otra vez.")
      return undefined
    }
    if (r.password !== PW) throw new CopyError("AUTH", "Contraseña incorrecta para «ana».")
    if (r.issue && r.session) {
      const s = r.session as { sid: string; webUser: string }
      const value = `token-${++n}`
      valid.set(value, { sid: s.sid, wu: s.webUser, exp: t() + COPY_ELEVATION_TTL_MS })
      return { value, expiresAt: t() + COPY_ELEVATION_TTL_MS }
    }
    return undefined
  }
  const ping: PingResult = {
    type: "result", op: "ping", version: "t", enabled: true, mount: { available: true, problem: null }, user: "ana", account: "ok", accountMessage: null,
    method: "python3", methodError: null, writePaths: [mediaDir],
  }
  const h: HelperClient & { calls: Call[]; valid: typeof valid; revoked: string[] } = {
    socketPath: "/fake", calls, valid, revoked: [],
    ping: async () => ping,
    async probe(r) {
      const token = check("probe", r as unknown as Record<string, unknown>)
      return { type: "result", op: "probe", real: r.dir, writable: true, freeBytes: 1, totalBytes: 2, folders: null, truncated: false, ...(token ? { token } : {}) }
    },
    async list(r) {
      const token = check("list", r as unknown as Record<string, unknown>)
      return {
        type: "result", op: "list", real: r.dir, truncated: false, writable: false, freeBytes: null, totalBytes: null, ...(token ? { token } : {}),
        entries: [{ name: "sub", kind: "dir", hidden: false, link: false, size: null, mtimeMs: 0 }, { name: "secreto.bin", kind: "file", hidden: false, link: false, size: 42, mtimeMs: 0 }],
      }
    },
    async mkdir(r) {
      const token = check("mkdir", r as unknown as Record<string, unknown>)
      return { type: "result", op: "mkdir", real: `${r.dir}/${r.name}`, name: r.name, ...(token ? { token } : {}) }
    },
    async copy(r, data) {
      const token = check("copy", r as unknown as Record<string, unknown>)
      const hash = crypto.createHash("sha256")
      for await (const ch of data.chunks) hash.update(ch)
      return { type: "result", op: "copy", name: r.name, skipped: false, replaced: false, sha256: hash.digest("hex"), size: r.size, ...(token ? { token } : {}) }
    },
    async mount(r) {
      const token = check("mount", r as unknown as Record<string, unknown>)
      if (r.device === "/dev/sda1") throw new CopyError("DEVICE", "/dev/sda1 no es un dispositivo extraíble ni USB: no se monta desde aquí.")
      const mp = path.join(mediaDir, "ana", "USB")
      fs.mkdirSync(mp, { recursive: true })
      return { type: "result", op: "mount", device: r.device, mountPoint: mp, fsType: "vfat", options: "nosuid,nodev,noexec", ...(token ? { token } : {}) }
    },
    async unmount(r) {
      const token = check("unmount", r as unknown as Record<string, unknown>)
      return { type: "result", op: "unmount", mountPoint: r.mountPoint, removedDir: true, ...(token ? { token } : {}) }
    },
    async revoke(token) {
      h.revoked.push(token)
      valid.delete(token)
      return { type: "result", op: "revoke" }
    },
  }
  return h
}

describe("«como administrador»: elevation of the browser session, browsing, mounting", () => {
  let tmp: string
  let locked: string
  let media: string
  let t = 1_000_000
  let helper: ReturnType<typeof fakeHelper>
  let svc: CopyService
  let audit: ReturnType<typeof fakeAudit>
  const isRoot = process.getuid?.() === 0

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rm-elev-svc-")))
    media = path.join(tmp, "media")
    locked = path.join(tmp, "privada")
    fs.mkdirSync(path.join(media, "x"), { recursive: true })
    fs.mkdirSync(locked)
    fs.chmodSync(locked, 0o000)
    fs.mkdirSync(path.join(tmp, "tftp"))
    fs.writeFileSync(path.join(tmp, "tftp", "a.bin"), "hola")
    makeFakeSysfs(path.join(tmp, "sys"), [{ name: "sdb", dev: "8:16", usb: true, removable: true, partitions: [{ name: "sdb1", dev: "8:17" }, { name: "sdb2", dev: "8:18" }] }])
    t = 1_000_000
    helper = fakeHelper(() => t, media)
    audit = fakeAudit()
    const config = testConfig({
      dataDir: path.join(tmp, "data"), backupDir: path.join(tmp, "data", "b"), captureDir: path.join(tmp, "data", "c"), dbFile: path.join(tmp, "data", "db"),
      files: { enabled: true, dir: path.join(tmp, "tftp"), maxUploadBytes: 1024 ** 3, deleteAdminOnly: false, extraEnabled: false, extraDir: path.join(tmp, "compartida"), extraName: "Compartida", extraHint: "Segunda carpeta compartida" },
      copy: { enabled: true, roots: ["/"], deny: [], rootPaths: [media], sudoUser: "ana", helperSocket: "/fake", testRemovable: null },
    })
    svc = createCopyService({
      config: { ...config, mode: "native" }, log: createNullLogger(), bus: fakeBus(), audit,
      openSource: async (_root: FilesRootId, rel: string) => {
        const p = path.join(tmp, "tftp", rel)
        const handle = await fs.promises.open(p, "r")
        const st = await handle.stat()
        return { handle, size: st.size, mtime: st.mtime, name: path.basename(rel), path: rel, mode: st.mode }
      },
    }, {
      helper, now: () => t, pingCacheMs: 0, progressMs: 0,
      drives: {
        mountinfo: async () => [mountLine(30, "8:17", "/media/ana/USB", "vfat", "/dev/sdb1")].join("\n"),
        swaps: async () => "", sysRoot: path.join(tmp, "sys"), devRoot: path.join(tmp, "dev"), udevDataDir: path.join(tmp, "udev"),
        statfs: async () => null, access: async () => "rw",
      },
      mountinfo: async () => "",
    })
  })
  afterEach(async () => {
    await svc.stop()
    fs.chmodSync(locked, 0o755)
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it.skipIf(isRoot)("an unreadable folder asks for the password; then it is listed through the helper, also on the next visits", async () => {
    const v = viewer()
    const first = await svc.browse(v, locked, false)
    expect(first).toMatchObject({ readable: false, needsElevation: true, elevation: null, asRoot: false, folders: [], files: [] })
    await expect(svc.browseAsRoot(v, locked, false, null)).rejects.toMatchObject({ details: { needsPassword: true, field: "password" } })
    await expect(svc.browseAsRoot(v, locked, false, "mala")).rejects.toMatchObject({ details: { field: "password", auth: "AUTH" } })
    const r = await svc.browseAsRoot(v, locked, false, PW)
    expect(r).toMatchObject({ asRoot: true, readable: true, needsElevation: false, folders: [{ name: "sub" }], files: [{ name: "secreto.bin", size: 42 }] })
    expect(r.elevation).toEqual({ until: new Date(t + COPY_ELEVATION_TTL_MS).toISOString(), user: "ana" })
    expect(helper.calls.at(-1)?.auth).toEqual({ password: PW, token: undefined, session: { sid: v.sid, webUser: "u-admin" }, issue: true })
    // Next visit: no password, the session's token.
    const again = await svc.browse(v, locked, false)
    expect(again).toMatchObject({ asRoot: true, files: [{ name: "secreto.bin" }] })
    expect(helper.calls.at(-1)?.auth).toMatchObject({ token: "token-1", session: { sid: v.sid, webUser: "u-admin" } })
    expect(helper.calls.at(-1)?.auth.password).toBeUndefined()
    // Another browser of the same admin (another login) is not elevated.
    expect(await svc.browse(viewer(admin, 2), locked, false)).toMatchObject({ needsElevation: true, elevation: null })
    // Five minutes later: the password again, and the helper is not even asked.
    const before = helper.calls.length
    t += COPY_ELEVATION_TTL_MS
    expect(await svc.browse(v, locked, false)).toMatchObject({ needsElevation: true, elevation: null })
    expect(helper.calls.length).toBe(before)
    expect(audit.inputs.filter((a) => a.action === "files.copy.elevate")).toHaveLength(1)
    expect(JSON.stringify(audit.inputs)).not.toContain(PW)
    expect(JSON.stringify(audit.inputs)).not.toContain("token-1")
  })

  it("a token the helper refuses is dropped: the dialog asks the password again", async () => {
    const v = viewer()
    await svc.browseAsRoot(v, media, false, PW)
    helper.valid.clear() // e.g. the helper's key changed
    await expect(svc.browseAsRoot(v, media, false, null)).rejects.toMatchObject({ details: { needsPassword: true } })
    expect((await svc.info(v)).elevation).toBeNull()
  })

  it("«Olvidar permisos» revokes the token in the helper", async () => {
    const v = viewer()
    await svc.browseAsRoot(v, media, false, PW)
    expect((await svc.info(v)).elevation).toMatchObject({ user: "ana" })
    await svc.forget(v)
    expect(helper.revoked).toEqual(["token-1"])
    expect((await svc.info(v)).elevation).toBeNull()
    expect(audit.inputs.filter((a) => a.action === "files.copy.forget")).toHaveLength(1)
    await svc.forget(v) // nothing to forget: no second audit
    expect(audit.inputs.filter((a) => a.action === "files.copy.forget")).toHaveLength(1)
  })

  it("«Montar»: the password (or the elevation), the result, the audit; «Expulsar» with the elevation", async () => {
    const v = viewer()
    await expect(svc.mount(v, { device: "/dev/sdb2", password: null })).rejects.toMatchObject({ details: { needsPassword: true } })
    const m = await svc.mount(v, { device: "/dev/sdb2", password: PW })
    expect(m).toMatchObject({ device: "/dev/sdb2", mountPoint: path.join(media, "ana", "USB"), fsType: "vfat", serviceWritable: true, elevation: { user: "ana" } })
    await expect(svc.mount(v, { device: "/dev/sda1", password: null })).rejects.toMatchObject({ message: expect.stringMatching(/no es un dispositivo extraíble/) })
    const u = await svc.unmount(v, { mountPoint: m.mountPoint, password: null })
    expect(u).toEqual({ mountPoint: m.mountPoint, removedDir: true, elevation: expect.objectContaining({ user: "ana" }) })
    expect(helper.calls.filter((c) => c.op === "unmount")[0]?.auth).toMatchObject({ token: "token-1" })
    await expect(svc.unmount(v, { mountPoint: "relativa", password: null })).rejects.toMatchObject({ details: { files: "INVALID" } })
    const acts = audit.inputs.map((a) => `${a.action}:${a.outcome ?? "ok"}`)
    expect(acts).toEqual(expect.arrayContaining(["files.copy.mount:ok", "files.copy.mount:error", "files.copy.unmount:ok", "files.copy.elevate:ok"]))
    expect(audit.inputs.find((a) => a.action === "files.copy.mount" && a.outcome !== "error")?.detail).toMatchObject({ device: "/dev/sdb2", fsType: "vfat", rootUser: "ana", serviceWritable: true })
    // Not an administrator.
    await expect(svc.mount(viewer(ana), { device: "/dev/sdb2", password: PW })).rejects.toMatchObject({ message: "Solo los administradores pueden copiar a carpetas del servidor." })
  })

  it("copies «como administrador» with the elevation (no password), and the jobs carry their root", async () => {
    const v = viewer()
    await svc.browseAsRoot(v, media, false, PW)
    const r = await svc.start(v, { root: "tftp", paths: ["a.bin"], destDir: path.join(media, "x"), conflict: "keep", asRoot: true, password: null })
    expect(r.jobs[0]).toMatchObject({ root: "tftp", asRoot: true, rootUser: "ana" })
    for (let i = 0; i < 100 && svc.jobs(admin.id)[0]?.state !== "done"; i++) await new Promise((res) => setTimeout(res, 10))
    expect(svc.jobs(admin.id)[0]).toMatchObject({ state: "done", error: null })
    const copyCall = helper.calls.find((c) => c.op === "copy")
    expect(copyCall?.auth).toMatchObject({ token: "token-1", session: { sid: v.sid } })
    expect(copyCall?.auth.password).toBeUndefined()
    expect(audit.inputs.find((a) => a.action === "files.copy" && a.outcome === "ok")?.detail).toMatchObject({ root: "tftp", path: "a.bin" })
  })

  it("info: unmounted removable devices and ejectable drives only when mounting is available", async () => {
    const info = await svc.info(viewer())
    expect(info.mount).toEqual({ available: true, problem: null })
    expect(info.devices.map((d) => d.device)).toEqual(["/dev/sdb2"])
    expect(info.drives).toEqual([expect.objectContaining({ device: "/dev/sdb1", ejectable: true })])
    const ping = await helper.ping()
    ping.mount = { available: false, problem: "El ayudante de montaje no responde" }
    const off = await svc.info(viewer())
    expect(off.mount).toEqual({ available: false, problem: "El ayudante de montaje no responde" })
    expect(off.devices).toEqual([])
    expect(off.drives[0]?.ejectable).toBe(false)
  })
})

// Type check of the request shapes the fake receives.
export type _Req = HelperRequest
