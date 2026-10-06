// «Copiar a una carpeta del servidor» through the files HTTP API: administrators only, the folder browser, new folder,
// the unprivileged copy (temp + rename, verified), «needs root» when the service cannot write, the deny-list, and the
// copy «como administrador (sudo)» through a real root helper on a temporary unix socket (run as the current user with
// injected account files), wrong password, cancel and the audit (never the password).
import { spawnSync } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import http, { type IncomingMessage } from "node:http"
import type { AddressInfo } from "node:net"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { CopyBrowseDTO, CopyInfoDTO, CopyJobDTO } from "@/lib/contracts/files"
import { createNullLogger } from "@/server/log"
import { createRequestListener } from "@/server/http/listen"
import type { AuthenticatedSession, AuthUser, FilesService } from "@/server/runtime/types"
import { AttemptLimiter, createCrypter } from "@/server/rootcopy/auth"
import { createRootCopyServer } from "@/server/rootcopy/server"
import { fakeAudit, fakeBus, testConfig } from "../../../../test/helpers"
import { createFilesServices } from ".."
import { createHelperClient } from "./helper-client"
import { buildPolicy } from "./policy"

const PW = "sudo-de-ana-1"
function mkhash(password: string): string {
  const py = "import ctypes,sys\nl=ctypes.CDLL('libcrypt.so.1')\nl.crypt_gensalt.restype=ctypes.c_char_p\nl.crypt.restype=ctypes.c_char_p\nsys.stdout.write(l.crypt(sys.stdin.buffer.read(),l.crypt_gensalt(b'$6$',0,None,0)).decode())"
  return spawnSync("python3", ["-c", py], { input: password, encoding: "utf8" }).stdout
}
const sha = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex")

let tmp: string
let files: string
let usb: string
let locked: string
let server: http.Server
let helper: ReturnType<typeof createRootCopyServer>
let svc: FilesService
let base: string
let audit: ReturnType<typeof fakeAudit>
let bus: ReturnType<typeof fakeBus>
const users: Record<string, AuthUser> = {
  admin: { id: "u-admin", username: "admin", name: "Admin", isAdmin: true, roleIds: [], mustChangePassword: false, sessionVersion: 1 },
  ana: { id: "u-ana", username: "ana", name: "Ana", isAdmin: false, roleIds: [], mustChangePassword: false, sessionVersion: 1 },
}
const data = crypto.randomBytes(2 * 1024 * 1024 + 5)

beforeEach(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rm-copy-")))
  files = path.join(tmp, "tftp")
  usb = path.join(tmp, "media", "USB")
  locked = path.join(tmp, "media", "solo-root")
  for (const d of [files, usb, locked, path.join(tmp, "data")]) fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(files, "BOOT.BIN"), data)
  fs.writeFileSync(path.join(files, "otro.txt"), "hola\n")
  fs.mkdirSync(path.join(files, "carpeta"))
  fs.chmodSync(locked, 0o555)

  // The root helper (as this user) on a temporary socket, authenticating "ana" (a sudo member) from injected files.
  fs.writeFileSync(path.join(tmp, "passwd"), "ana:x:1000:1000::/home/ana:/bin/bash\n")
  fs.writeFileSync(path.join(tmp, "group"), "sudo:x:27:ana\n")
  fs.writeFileSync(path.join(tmp, "shadow"), `ana:${mkhash(PW)}:19800:0:99999:7:::\n`)
  const sock = path.join(tmp, "rootcopy.sock")
  helper = createRootCopyServer({
    config: { enabled: true, sudoUser: "ana", sudoGroups: ["sudo"], writePaths: [path.join(tmp, "media")], policy: buildPolicy(["/"], [], []) },
    files: { passwd: path.join(tmp, "passwd"), group: path.join(tmp, "group"), shadow: path.join(tmp, "shadow") },
    crypter: createCrypter(), limiter: new AttemptLimiter({ file: null }), version: "test", failDelayMs: 0,
  })
  await new Promise<void>((r) => helper.listen(sock, r))

  audit = fakeAudit()
  bus = fakeBus()
  const config = testConfig({
    dataDir: path.join(tmp, "data"), backupDir: path.join(tmp, "data", "b"), captureDir: path.join(tmp, "data", "c"), dbFile: path.join(tmp, "data", "db"),
    files: { enabled: true, dir: files, maxUploadBytes: 1024 ** 3, deleteAdminOnly: false, extraEnabled: false, extraDir: path.join(tmp, "compartida"), extraName: "Compartida", extraHint: "Segunda carpeta compartida" },
    copy: { enabled: true, roots: ["/"], deny: [], rootPaths: [path.join(tmp, "media")], sudoUser: "ana", helperSocket: sock, testRemovable: null },
  })
  svc = createFilesServices({
    config, log: createNullLogger(), bus, audit, prisma: undefined as never, settings: undefined as never,
    authenticate: async (req: IncomingMessage): Promise<AuthenticatedSession | null> => {
      const m = /sid=(\w+)/.exec(String(req.headers.cookie ?? ""))
      const user = m ? users[m[1]] : undefined
      // One login session per user (the elevation of «como administrador» belongs to it).
      return user ? { user, sv: 1, loginAt: 1_700_000_000_000 } : null
    },
  }, {
    reserveBytes: 0,
    copy: {
      helper: createHelperClient(sock), progressMs: 0, pingCacheMs: 0,
      drives: {
        mountinfo: async () => "90 22 8:17 / /media/ana/USB rw,relatime - vfat /dev/sdb1 rw\n", sysRoot: path.join(tmp, "nosys"), devRoot: path.join(tmp, "nodev"),
        statfs: async () => ({ freeBytes: 1e9, totalBytes: 4e9 }), access: async () => "rw",
      },
    },
  })
  await svc.start()
  server = http.createServer()
  const cfgRef = { tls: null, port: 0 }
  server.on("request", createRequestListener(cfgRef, (req, r) => {
    if (!svc.handleRequest(req, r)) { r.writeHead(418); r.end() }
  }))
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  cfgRef.port = (server.address() as AddressInfo).port
  base = `http://127.0.0.1:${cfgRef.port}`
})

afterEach(async () => {
  await svc.stop()
  await new Promise((r) => server.close(r))
  await new Promise((r) => helper.close(r))
  fs.chmodSync(locked, 0o755)
  fs.rmSync(tmp, { recursive: true, force: true })
})

const H = (u = "admin") => ({ cookie: `sid=${u}`, origin: base, "content-type": "application/json" })
const get = (p: string, u = "admin") => fetch(`${base}${p}`, { headers: H(u) })
const post = (p: string, body: unknown, u = "admin") => fetch(`${base}${p}`, { method: "POST", headers: H(u), body: JSON.stringify(body) })
const copy = (body: Record<string, unknown>, u = "admin") => post("/api/files/copy", { paths: ["BOOT.BIN"], destDir: usb, conflict: "keep", asRoot: false, password: null, ...body }, u)
const jobsOf = async (u = "admin") => ((await (await get("/api/files/copy", u)).json()) as { jobs: CopyJobDTO[] }).jobs
async function until(what: string, fn: () => Promise<boolean> | boolean, ms = 10_000): Promise<void> {
  const t0 = Date.now()
  while (!(await fn())) {
    if (Date.now() - t0 > ms) throw new Error(`Tiempo agotado esperando ${what}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}
const finished = (j: CopyJobDTO) => ["done", "skipped", "error", "canceled"].includes(j.state)

describe("Copiar a una carpeta del servidor (API)", () => {
  it("administrators only: the API refuses everyone else (and audits it)", async () => {
    for (const r of [await get("/api/files/copy/info", "ana"), await get(`/api/files/copy/browse?path=${encodeURIComponent(usb)}`, "ana"), await copy({}, "ana"),
      await post("/api/files/copy/mkdir", { dir: usb, name: "x", asRoot: false, password: null }, "ana")]) {
      expect(r.status).toBe(403)
      expect(((await r.json()) as { message: string }).message).toBe("Solo los administradores pueden copiar a carpetas del servidor.")
    }
    expect(await jobsOf("ana")).toEqual([])
    expect(audit.inputs.filter((a) => a.action === "files.copy" && a.outcome === "denied")).toHaveLength(4)
    expect(fs.readdirSync(usb)).toEqual([])
  })

  it("info: drives, roots and the root helper (who authenticates)", async () => {
    const r = (await (await get("/api/files/copy/info")).json()) as CopyInfoDTO
    expect(r.roots).toEqual(["/"])
    expect(r.drives).toEqual([expect.objectContaining({ mountPoint: "/media/ana/USB", fsType: "vfat", label: "USB", writable: true })])
    expect(r.root).toMatchObject({ available: true, user: "ana", problem: null, writePaths: [path.join(tmp, "media")] })
  })

  it("browse: folders, then files (metadata), writable or not, the parent, denied system folders", async () => {
    fs.mkdirSync(path.join(usb, "fotos"))
    fs.mkdirSync(path.join(usb, ".oculta"))
    fs.writeFileSync(path.join(usb, "f.txt"), "x")
    const b = (await (await get(`/api/files/copy/browse?path=${encodeURIComponent(usb)}`)).json()) as CopyBrowseDTO
    expect(b).toMatchObject({ path: usb, parent: path.dirname(usb), readable: true, writable: true, denied: null, rootWritable: true, asRoot: false })
    expect(b.folders.map((f) => f.name)).toEqual(["fotos"])
    expect(b.files).toEqual([{ name: "f.txt", hidden: false, link: false, size: 1, mtime: expect.any(String) }])
    expect(b).toMatchObject({ needsElevation: false, elevation: null })
    const h = (await (await get(`/api/files/copy/browse?path=${encodeURIComponent(usb)}&hidden=1`)).json()) as CopyBrowseDTO
    expect(h.folders.map((f) => f.name)).toEqual([".oculta", "fotos"])
    const etc = (await (await get("/api/files/copy/browse?path=/etc")).json()) as CopyBrowseDTO
    expect(etc).toMatchObject({ path: "/etc", writable: false, denied: expect.stringMatching(/carpeta del sistema/) })
    expect((await get("/api/files/copy/browse?path=relativa")).status).toBe(400)
    expect((await get(`/api/files/copy/browse?path=${encodeURIComponent(path.join(tmp, "nada"))}`)).status).toBe(404)
  })

  it("copies as the service: verified, 0644, progress to that user only, audited", async () => {
    const r = await copy({ paths: ["BOOT.BIN", "otro.txt"] })
    expect(r.status).toBe(202)
    const started = ((await r.json()) as { jobs: CopyJobDTO[] }).jobs
    expect(started.map((j) => [j.name, j.asRoot, j.destDir])).toEqual([["BOOT.BIN", false, usb], ["otro.txt", false, usb]])
    await until("las copias", async () => (await jobsOf()).every((j) => j.state === "done"))
    const jobs = await jobsOf()
    expect(jobs[0]).toMatchObject({ finalName: "BOOT.BIN", sha256: sha(data), copied: data.length, replaced: false, error: null })
    expect(sha(fs.readFileSync(path.join(usb, "BOOT.BIN")))).toBe(sha(data))
    expect(fs.statSync(path.join(usb, "BOOT.BIN")).mode & 0o777).toBe(0o644)
    expect(fs.readdirSync(usb).sort()).toEqual(["BOOT.BIN", "otro.txt"])
    const evs = bus.events.filter((e) => e.event.type === "files.copy")
    expect(evs.length).toBeGreaterThan(2)
    expect(evs.every((e) => e.audience.kind === "user" && e.audience.userId === "u-admin")).toBe(true)
    const a = audit.inputs.find((x) => x.action === "files.copy" && x.outcome === "ok" && x.detail?.path === "BOOT.BIN")
    expect(a?.detail).toMatchObject({ path: "BOOT.BIN", sizeBytes: data.length, dest: usb, asRoot: false, result: "copiado", checksum: `verificado (sha256 ${sha(data)})` })
    // Again: «Conservar ambos» then «Omitir».
    await copy({})
    await until("la segunda copia", async () => (await jobsOf()).filter(finished).length === 3)
    expect((await jobsOf()).at(-1)).toMatchObject({ state: "done", finalName: "BOOT (1).BIN" })
    await copy({ conflict: "skip" })
    await until("la copia omitida", async () => (await jobsOf()).length === 4 && (await jobsOf()).every(finished))
    expect((await jobsOf()).at(-1)).toMatchObject({ state: "skipped", finalName: null })
  })

  it("an unwritable folder offers the copy as administrator; denied folders and folders as sources are refused", async () => {
    const r = await copy({ destDir: locked })
    expect(r.status).toBe(403)
    expect(await r.json()).toMatchObject({ error: "FORBIDDEN", needsRoot: true, message: expect.stringMatching(/copia como administrador \(sudo\)/) })
    const etc = await copy({ destDir: "/etc" })
    expect(etc.status).toBe(403)
    expect(((await etc.json()) as { needsRoot?: boolean }).needsRoot).toBeUndefined()
    expect((await copy({ paths: ["carpeta"] })).status).toBe(400)
    expect((await copy({ paths: ["../fuera"] })).status).toBe(400)
    expect(await jobsOf()).toEqual([])
  })

  it("as administrator (sudo): a wrong password is refused before anything is queued; the right one copies", async () => {
    const bad = await copy({ asRoot: true, password: "mala", destDir: usb })
    expect(bad.status).toBe(403)
    expect(await bad.json()).toMatchObject({ field: "password", message: "Contraseña incorrecta para «ana»." })
    const none = await copy({ asRoot: true, password: null })
    expect(none.status).toBe(403)
    expect(await none.json()).toMatchObject({ needsPassword: true, field: "password", message: "Escribe la contraseña de ana (sudo)." })
    expect(await jobsOf()).toEqual([])
    const ok = await copy({ asRoot: true, password: PW })
    expect(ok.status).toBe(202)
    // The password elevates this browser session (5 min): the token stays on the server.
    const okBody = (await ok.json()) as { elevation: { until: string; user: string } | null }
    expect(okBody.elevation).toMatchObject({ user: "ana" })
    expect(JSON.stringify(okBody)).not.toMatch(/token/i)
    await until("la copia como administrador", async () => (await jobsOf()).every(finished))
    expect((await jobsOf())[0]).toMatchObject({ state: "done", asRoot: true, rootUser: "ana", sha256: sha(data) })
    expect(sha(fs.readFileSync(path.join(usb, "BOOT.BIN")))).toBe(sha(data))
    const a = audit.inputs.filter((x) => x.action === "files.copy")
    expect(a.find((x) => x.outcome === "denied")?.detail).toMatchObject({ asRoot: true, rootUser: "ana", code: "AUTH" })
    expect(a.find((x) => x.outcome === "ok")?.detail).toMatchObject({ asRoot: true, rootUser: "ana", result: "copiado" })
    expect(JSON.stringify(audit.inputs)).not.toContain(PW)
    expect(JSON.stringify(audit.inputs)).not.toContain("mala")
    // Elevated: the next copy «como administrador» needs no password, until «Olvidar permisos».
    const again = await copy({ asRoot: true, password: null, conflict: "replace" })
    expect(again.status).toBe(202)
    await until("la copia con los permisos recordados", async () => (await jobsOf()).every(finished))
    expect((await jobsOf()).at(-1)).toMatchObject({ state: "done", asRoot: true, replaced: true })
    expect(((await (await get("/api/files/copy/info")).json()) as CopyInfoDTO).elevation).toMatchObject({ user: "ana" })
    expect((await fetch(`${base}/api/files/copy/elevation`, { method: "DELETE", headers: H() })).status).toBe(204)
    expect(((await (await get("/api/files/copy/info")).json()) as CopyInfoDTO).elevation).toBeNull()
    expect((await copy({ asRoot: true, password: null })).status).toBe(403)
    expect(audit.inputs.map((x) => x.action)).toEqual(expect.arrayContaining(["files.copy.elevate", "files.copy.forget"]))
    // Outside RM_COPY_ROOT_PATHS the helper refuses (as root only /media, /run/media, /mnt by default).
    const out = await copy({ asRoot: true, password: PW, destDir: files })
    expect(out.status).toBe(403)
    expect(((await out.json()) as { message: string }).message).toMatch(/RM_COPY_ROOT_PATHS/)
  })

  it("browse and new folder as administrator", async () => {
    const b = (await (await post("/api/files/copy/browse", { path: usb, hidden: false, password: PW })).json()) as CopyBrowseDTO
    expect(b).toMatchObject({ path: usb, asRoot: true, readable: true, rootWritable: true })
    expect((await post("/api/files/copy/browse", { path: usb, hidden: false, password: "mala" })).status).toBe(403)
    const m = await post("/api/files/copy/mkdir", { dir: usb, name: "nueva", asRoot: true, password: PW })
    expect(m.status).toBe(201)
    expect(await m.json()).toEqual({ path: path.join(usb, "nueva"), elevation: { until: expect.any(String), user: "ana" } })
    const m2 = await post("/api/files/copy/mkdir", { dir: usb, name: "otra", asRoot: false, password: null })
    expect(await m2.json()).toMatchObject({ path: path.join(usb, "otra") })
    expect((await post("/api/files/copy/mkdir", { dir: usb, name: "otra", asRoot: false, password: null })).status).toBe(409)
    expect((await post("/api/files/copy/mkdir", { dir: locked, name: "x", asRoot: false, password: null })).status).toBe(403)
    expect(audit.inputs.filter((a) => a.action === "files.copy.mkdir").map((a) => a.detail)).toEqual([
      { path: path.join(usb, "nueva"), asRoot: true, rootUser: "ana" }, { path: path.join(usb, "otra"), asRoot: false },
    ])
  })

  it("cancel: the copy stops and leaves no temporary file (as the service and as administrator)", async () => {
    fs.writeFileSync(path.join(files, "grande.bin"), crypto.randomBytes(48 * 1024 * 1024))
    for (const asRoot of [false, true]) {
      const r = await copy({ paths: ["grande.bin"], asRoot, password: asRoot ? PW : null })
      const [job] = ((await r.json()) as { jobs: CopyJobDTO[] }).jobs
      await until("que empiece", async () => (await jobsOf()).find((j) => j.id === job.id)?.state !== "queued")
      expect((await fetch(`${base}/api/files/copy/${job.id}`, { method: "DELETE", headers: H() })).status).toBe(204)
      await until("la cancelación", async () => finished((await jobsOf()).find((j) => j.id === job.id)!))
      const j = (await jobsOf()).find((x) => x.id === job.id)!
      if (j.state !== "done") expect(j.state).toBe("canceled")
      await until("que se borre el temporal", () => fs.readdirSync(usb).every((n) => !n.startsWith(".rm-copy-")))
    }
    expect((await fetch(`${base}/api/files/copy/${"0".repeat(32)}`, { method: "DELETE", headers: H() })).status).toBe(404)
  })
})
