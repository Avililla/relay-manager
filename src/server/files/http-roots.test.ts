// The files API with two roots (tftp and the second folder), the download script routes and the copy routes' plumbing (the copy
// service itself is tested in copy/service.test.ts; here a stub checks what the HTTP layer hands it).
import fs from "node:fs"
import http, { type IncomingMessage } from "node:http"
import type { AddressInfo } from "node:net"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { CopyBrowseDTO, ExportJobDTO } from "@/lib/contracts/files"
import { createNullLogger } from "@/server/log"
import { createRequestListener } from "@/server/http/listen"
import type { AuthenticatedSession, AuthUser } from "@/server/runtime/types"
import { fakeAudit, fakeBus, testConfig, withTempDir } from "../../../test/helpers"
import { createFilesServices } from "."
import { createFilesCore } from "./core"
import { createFilesHttp } from "./http"
import { sessionIdOf, type CopyService, type CopyViewer } from "./copy/service"

const FAKE = path.resolve(__dirname, "../../../test/fixtures/fake-export-downloader.sh")
const USERS: Record<string, AuthUser> = {
  ana: { id: "u1", username: "ana", name: "Ana", isAdmin: false, roleIds: [], mustChangePassword: false, sessionVersion: 1 },
  bea: { id: "u3", username: "bea", name: "Bea", isAdmin: false, roleIds: [], mustChangePassword: false, sessionVersion: 1 },
  admin: { id: "u9", username: "admin", name: "Admin", isAdmin: true, roleIds: [], mustChangePassword: false, sessionVersion: 4 },
}
const LOGIN_AT = 1_700_000_000_000

let t: { dir: string; cleanup: () => void }
let tftp: string
let extra: string
let server: http.Server | null = null
let base: string
let bus: ReturnType<typeof fakeBus>
let audit: ReturnType<typeof fakeAudit>
let stopSvc: (() => Promise<void>) | null = null

const authenticate = async (req: IncomingMessage): Promise<AuthenticatedSession | null> => {
  const m = /sid=(\w+)/.exec(String(req.headers.cookie ?? ""))
  const user = m ? USERS[m[1]] : undefined
  return user ? { user, sv: user.sessionVersion, loginAt: LOGIN_AT } : null
}

async function listen(handle: (req: http.IncomingMessage, res: http.ServerResponse) => boolean) {
  const srv = http.createServer()
  server = srv
  const cfgRef = { tls: null, port: 0 }
  srv.on("request", createRequestListener(cfgRef, (req, res) => {
    if (!handle(req, res)) {
      res.writeHead(418)
      res.end()
    }
  }))
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r))
  cfgRef.port = (srv.address() as AddressInfo).port
  base = `http://127.0.0.1:${cfgRef.port}`
}

function config(extraEnabled = true) {
  const b = testConfig()
  return testConfig({
    dataDir: path.join(t.dir, "data"), backupDir: path.join(t.dir, "data", "b"), captureDir: path.join(t.dir, "data", "c"),
    dbFile: path.join(t.dir, "data", "db"), appDir: path.join(t.dir, "app"),
    files: { ...b.files, dir: tftp, extraEnabled, extraDir: extra, extraName: "Compartida", extraHint: "Segunda carpeta compartida" },
    exports: { ...b.exports, script: FAKE, user: "downloader", password: "clave-secreta" },
  })
}

async function start(extraEnabled = true) {
  bus = fakeBus()
  audit = fakeAudit()
  const svc = createFilesServices({
    config: config(extraEnabled), log: createNullLogger(), bus, audit, prisma: undefined as never, settings: undefined as never, authenticate,
  }, { reserveBytes: 0, exports: { publishMs: 10, killGraceMs: 500 } })
  await svc.start()
  stopSvc = () => svc.stop()
  await listen((req, res) => svc.handleRequest(req, res))
  return svc
}

const H = (u = "ana") => ({ cookie: `sid=${u}`, origin: base, "content-type": "application/json" })
const get = (p: string, u = "ana") => fetch(`${base}${p}`, { headers: { cookie: `sid=${u}` } })
const post = (p: string, body: unknown, u = "ana") => fetch(`${base}${p}`, { method: "POST", headers: H(u), body: JSON.stringify(body) })
const del = (p: string, u = "ana") => fetch(`${base}${p}`, { method: "DELETE", headers: H(u) })

beforeEach(() => {
  t = withTempDir("rm-files-roots-")
  tftp = path.join(t.dir, "tftp")
  extra = path.join(t.dir, "compartida")
  fs.mkdirSync(tftp)
  fs.mkdirSync(path.join(extra, "apps"), { recursive: true })
  fs.mkdirSync(path.join(t.dir, "data"))
  fs.writeFileSync(path.join(tftp, "boot.bin"), "tftp")
  fs.writeFileSync(path.join(extra, "notas.txt"), "extra")
})
afterEach(async () => {
  await stopSvc?.()
  stopSvc = null
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()))
  server = null
  t.cleanup()
})

describe("two roots", () => {
  it("lists, downloads, uploads and zips in the chosen root; tftp is the default; unknown → 400; disabled → 404", async () => {
    const svc = await start()
    expect(svc.roots().map((r) => [r.id, r.label, r.path])).toEqual([["tftp", "tftp", tftp], ["extra", "Compartida", extra]])
    const lt = await (await get("/api/files/list?path=")).json() as { root: string; entries: Array<{ name: string }> }
    expect(lt.root).toBe("tftp")
    expect(lt.entries.map((e) => e.name)).toEqual(["boot.bin"])
    const le = await (await get("/api/files/list?root=extra&path=")).json() as { root: string; entries: Array<{ name: string }> }
    expect(le.root).toBe("extra")
    expect(le.entries.map((e) => e.name).sort()).toEqual(["apps", "notas.txt"]) // .descargas is never listed
    // A reserved name (the work folder of the 2.4.0 betas): still hidden and protected if it is there.
    fs.mkdirSync(path.join(extra, ".descargas"), { recursive: true })
    expect(await (await get("/api/files/download?root=extra&path=notas.txt")).text()).toBe("extra")
    expect((await get("/api/files/download?root=tftp&path=notas.txt")).status).toBe(404)
    expect((await get("/api/files/list?root=otra&path=")).status).toBe(400)
    // Upload into the second folder.
    const up = await post("/api/files/upload", { root: "extra", dir: "apps", name: "x.bin", size: 3, conflict: "fail" })
    expect(up.status).toBe(201)
    const { id } = await up.json() as { id: string }
    const put = await fetch(`${base}/api/files/upload/${id}?offset=0`, { method: "PUT", headers: { cookie: "sid=ana", origin: base, "content-type": "application/octet-stream" }, body: Buffer.from("abc") })
    expect(await put.json()).toMatchObject({ done: true, path: "apps/x.bin" })
    expect(fs.readFileSync(path.join(extra, "apps", "x.bin"), "utf8")).toBe("abc")
    expect(bus.events.some((e) => e.event.type === "files.changed" && e.event.root === "extra" && e.event.dirs[0] === "apps")).toBe(true)
    expect(audit.inputs.find((a) => a.action === "files.upload")?.detail).toMatchObject({ root: "extra", path: "apps/x.bin" })
    // Archive of the second root: .descargas never inside.
    fs.writeFileSync(path.join(extra, ".descargas", "secreto"), "no")
    const zip = Buffer.from(await (await get("/api/files/archive?root=extra&format=zip&dir=")).arrayBuffer())
    expect(zip.includes(Buffer.from("notas.txt"))).toBe(true)
    expect(zip.includes(Buffer.from(".descargas"))).toBe(false)
    expect(audit.inputs.filter((a) => a.action === "files.download").every((a) => typeof (a.detail as Record<string, unknown>).root === "string")).toBe(true)
  })

  it("the reserved .descargas folder of the second root cannot be reached nor created by users", async () => {
    const svc = await start()
    fs.mkdirSync(path.join(extra, ".descargas"), { recursive: true })
    fs.writeFileSync(path.join(extra, ".descargas", "jf"), "binario")
    fs.symlinkSync(path.join(extra, ".descargas"), path.join(extra, "atajo"))
    const actor = { kind: "user" as const, id: "u1", name: "ana" }
    expect((await get("/api/files/list?root=extra&path=.descargas")).status).toBe(404)
    expect((await get("/api/files/download?root=extra&path=.descargas/jf")).status).toBe(404)
    expect((await get("/api/files/list?root=extra&path=atajo")).status).toBe(404)
    expect((await post("/api/files/upload", { root: "extra", dir: "", name: ".descargas", size: 1, conflict: "overwrite" })).status).toBe(400)
    expect((await post("/api/files/upload", { root: "extra", dir: ".descargas", name: "x", size: 1 })).status).toBe(404)
    await expect(svc.mkdir("extra", "", ".descargas", actor)).rejects.toMatchObject({ details: { files: "INVALID" } })
    await expect(svc.rename("extra", "notas.txt", ".descargas", actor)).rejects.toMatchObject({ details: { files: "INVALID" } })
    await expect(svc.remove("extra", [".descargas"], actor)).rejects.toMatchObject({ details: { files: "NOT_FOUND" } })
    await expect(svc.move("extra", ["notas.txt"], ".descargas", actor)).rejects.toMatchObject({ details: { files: "NOT_FOUND" } })
    // In tftp the name is not special.
    await expect(svc.mkdir("tftp", "", ".descargas", actor)).resolves.toEqual({ path: ".descargas" })
    expect(fs.readFileSync(path.join(extra, ".descargas", "jf"), "utf8")).toBe("binario")
  })

  it("second folder disabled: 404 for its requests, tftp unchanged", async () => {
    const svc = await start(false)
    expect(svc.roots().map((r) => r.id)).toEqual(["tftp"])
    expect((await get("/api/files/list?root=extra&path=")).status).toBe(404)
    expect((await get("/api/files/list?path=")).status).toBe(200)
    const r = await get("/api/files/export")
    expect((await r.json() as { info: { available: boolean } }).info.available).toBe(false)
  })
})

describe("export downloader API", () => {
  async function waitJob(id: string, u = "ana"): Promise<ExportJobDTO> {
    for (let i = 0; i < 300; i++) {
      const { jobs } = await (await get("/api/files/export", u)).json() as { jobs: ExportJobDTO[] }
      const j = jobs.find((x) => x.id === id)
      if (j && ["done", "error", "canceled"].includes(j.state)) return j
      await new Promise((r) => setTimeout(r, 50))
    }
    throw new Error("timeout")
  }

  it("starts a download into the second folder, streams it, lists the zip; validation; others cannot cancel", async () => {
    await start()
    const info = await (await get("/api/files/export")).json() as { info: { available: boolean; timeoutMin: number } }
    expect(info.info).toMatchObject({ available: true, timeoutMin: 60 })
    expect((await post("/api/files/export", { app: "a;id", version: "1", extract: false, zipName: null, dir: "" })).status).toBe(400)
    const bad = await (await post("/api/files/export", { app: "-x", version: "1", extract: false, zipName: null, dir: "" })).json() as { field: string; message: string }
    expect(bad).toMatchObject({ field: "app", message: expect.stringMatching(/^Aplicación: /) })
    expect((await post("/api/files/export", { app: "app", version: "1", extract: false, zipName: null, dir: "nope" })).status).toBe(404)
    const r = await post("/api/files/export", { app: "app_demo", version: "4.1.0", extract: true, zipName: "entrega", dir: "apps" })
    expect(r.status).toBe(202)
    const { job } = await r.json() as { job: ExportJobDTO }
    expect(job).toMatchObject({ zipName: "entrega.zip", dir: "apps", userName: "Ana" })
    // Bea does not see it nor can cancel it; the admin sees it.
    expect(((await (await get("/api/files/export", "bea")).json()) as { jobs: unknown[] }).jobs).toEqual([])
    expect((await del(`/api/files/export/${job.id}`, "bea")).status).toBe(404)
    const done = await waitJob(job.id)
    expect(done).toMatchObject({ state: "done", finalPath: "apps/entrega.zip" })
    expect(done.log.join("\n")).not.toContain("clave-secreta")
    const adminView = await (await get("/api/files/export", "admin")).json() as { jobs: ExportJobDTO[] }
    expect(adminView.jobs.map((j) => j.id)).toContain(job.id)
    const l = await (await get("/api/files/list?root=extra&path=apps")).json() as { entries: Array<{ name: string }> }
    expect(l.entries.map((e) => e.name)).toContain("entrega.zip")
    expect(bus.events.some((e) => e.event.type === "files.export" && e.event.lines.length > 0)).toBe(true)
  })

  it("cancel through the API", async () => {
    await start()
    const { job } = await (await post("/api/files/export", { app: "slow", version: "1", extract: false, zipName: null, dir: "" })).json() as { job: ExportJobDTO }
    await new Promise((r) => setTimeout(r, 200))
    expect((await del(`/api/files/export/${job.id}`)).status).toBe(204)
    expect((await waitJob(job.id)).state).toBe("canceled")
  })
})

describe("copy routes (plumbing)", () => {
  it("hands the copy service the viewer with the session id, nullable passwords, mount/unmount/elevation", async () => {
    const calls: Array<[string, CopyViewer, unknown]> = []
    const browse: CopyBrowseDTO = {
      path: "/media", parent: "/", readable: true, writable: false, denied: null, rootWritable: true, readOnlyMount: false, folders: [], files: [],
      truncated: false, freeBytes: null, totalBytes: null, asRoot: false, needsElevation: false, elevation: null,
    }
    const rec = (name: string) => async (v: CopyViewer, ...rest: unknown[]) => {
      calls.push([name, v, rest])
      return {} as never
    }
    const copy: CopyService = {
      info: rec("info"), browse: async (v, p, hidden) => { calls.push(["browse", v, [p, hidden]]); return browse },
      browseAsRoot: async (v, p, hidden, password) => { calls.push(["browseAsRoot", v, [p, hidden, password]]); return { ...browse, asRoot: true } },
      mkdir: rec("mkdir"), start: rec("start"), mount: rec("mount"), unmount: rec("unmount"), forget: async (v) => { calls.push(["forget", v, null]) },
      jobs: () => [], cancel: () => false, clearFinished: () => undefined, rootStatus: async () => ({ available: false, user: null, problem: null, hint: null, writePaths: [] }),
      stats: () => ({ active: 0, queued: 0 }), stop: async () => undefined,
    }
    const cfg = config()
    const core = createFilesCore({ config: cfg, log: createNullLogger(), bus: fakeBus(), audit: fakeAudit(), root: { id: "tftp", dir: tftp, reserved: [] } })
    await listen(createFilesHttp({ cores: { tftp: core, extra: null }, copy, enabled: true, log: createNullLogger(), audit: fakeAudit(), authenticate }))
    const sid = sessionIdOf({ user: { id: "u9" }, sv: 4, loginAt: LOGIN_AT })
    expect(sid).toMatch(/^[0-9a-f]{64}$/)
    expect(await (await post("/api/files/copy/browse", { path: "/root", hidden: false, password: null }, "admin")).json()).toMatchObject({ asRoot: true })
    expect((await post("/api/files/copy/mount", { device: "/dev/sdb1", password: null }, "admin")).status).toBe(200)
    expect((await post("/api/files/copy/mount", { device: "/dev/sda1;id", password: null }, "admin")).status).toBe(400)
    expect((await post("/api/files/copy/unmount", { mountPoint: "/media/ana/USB", password: "x" }, "admin")).status).toBe(200)
    expect((await del("/api/files/copy/elevation", "admin")).status).toBe(204)
    expect((await post("/api/files/copy", { root: "extra", paths: ["a"], destDir: "/media", conflict: "keep", asRoot: true, password: null }, "admin")).status).toBe(404)
    expect((await post("/api/files/copy", { paths: ["a"], destDir: "/media", conflict: "keep", asRoot: true, password: null }, "admin")).status).toBe(202)
    expect(calls.map((c) => c[0])).toEqual(["browseAsRoot", "mount", "unmount", "forget", "start"])
    expect(calls.every((c) => c[1].sid === sid && c[1].user.id === "u9" && c[1].ip === "127.0.0.1")).toBe(true)
    expect(calls[0][2]).toEqual(["/root", false, null])
    expect(calls[1][2]).toEqual([{ device: "/dev/sdb1", password: null }])
    expect(calls[4][2]).toEqual([{ root: "tftp", paths: ["a"], destDir: "/media", conflict: "keep", asRoot: true, password: null }])
  })
})
