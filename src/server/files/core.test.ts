import fs from "node:fs"
import path from "node:path"
import { Readable, Writable } from "node:stream"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { UPLOAD_TEMP_PREFIX } from "@/lib/contracts/files"
import { isDomainError } from "@/server/errors"
import { createNullLogger } from "@/server/log"
import type { ActorRef } from "@/server/runtime/types"
import { fakeAudit, fakeBus, withTempDir } from "../../../test/helpers"
import { createFilesCore, type FilesInternals } from "./core"

const actor: ActorRef = { kind: "user", id: "u1", name: "ana", ip: "10.0.0.2" }
const uploader = { id: "u1", name: "Ana", username: "ana", ip: "10.0.0.2", isAdmin: false }

let t: { dir: string; cleanup: () => void }
let root: string
let outside: string
let bus: ReturnType<typeof fakeBus>
let audit: ReturnType<typeof fakeAudit>

function make(internals: FilesInternals = {}, files: Partial<{ maxUploadBytes: number; deleteAdminOnly: boolean }> = {}) {
  return createFilesCore({
    config: {
      files: { enabled: true, dir: root, maxUploadBytes: files.maxUploadBytes ?? 1024 * 1024 * 1024, deleteAdminOnly: files.deleteAdminOnly ?? false, extraEnabled: false, extraDir: "/nonexistent-extra", extraName: "Compartida", extraHint: "Segunda carpeta compartida" },
      dataDir: path.join(t.dir, "data"), backupDir: path.join(t.dir, "data", "backups"), captureDir: path.join(t.dir, "data", "consoles"),
      dbFile: path.join(t.dir, "data", "relay-manager.db"), appDir: path.join(t.dir, "app"),
    },
    log: createNullLogger(), bus, audit,
  }, { reserveBytes: 0, ...internals })
}

async function kindOf(p: Promise<unknown>): Promise<string> {
  try {
    await p
    return "ok"
  } catch (e) {
    return isDomainError(e) ? String(e.details?.files) : `throw ${String(e)}`
  }
}
const body = (s: string | Buffer) => Readable.from([Buffer.from(s)])
const temps = (dir = root) => fs.readdirSync(dir).filter((n) => n.startsWith(UPLOAD_TEMP_PREFIX))

async function upload(core: ReturnType<typeof make>, dir: string, name: string, data: string | Buffer, conflict: "fail" | "overwrite" | "rename" = "fail") {
  const buf = Buffer.from(data)
  const s = await core.uploadStart({ dir, name, size: buf.length, conflict }, uploader)
  return core.uploadChunk(s.id, "u1", 0, body(buf))
}

beforeEach(() => {
  t = withTempDir("rm-files-core-")
  root = path.join(t.dir, "tftp")
  outside = path.join(t.dir, "secreto")
  fs.mkdirSync(path.join(root, "sub"), { recursive: true })
  fs.mkdirSync(path.join(t.dir, "data"))
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(root, "a.txt"), "aaa")
  fs.writeFileSync(path.join(root, "sub", "b.txt"), "bb")
  fs.writeFileSync(path.join(outside, "auth-secret"), "top secret")
  fs.symlinkSync(path.join(outside, "auth-secret"), path.join(root, "escape-file"))
  fs.symlinkSync(outside, path.join(root, "escape-dir"))
  fs.symlinkSync("a.txt", path.join(root, "inside-link"))
  bus = fakeBus()
  audit = fakeAudit()
})
afterEach(() => t.cleanup())

describe("list", () => {
  it("lists files, folders and links; hides upload temporaries; reports the disk", async () => {
    fs.writeFileSync(path.join(root, `${UPLOAD_TEMP_PREFIX}0123.part`), "x")
    const l = await make().list("")
    const by = Object.fromEntries(l.entries.map((e) => [e.name, e]))
    expect(Object.keys(by).sort()).toEqual(["a.txt", "escape-dir", "escape-file", "inside-link", "sub"])
    expect(by["a.txt"]).toMatchObject({ kind: "file", size: 3, link: false })
    expect(by.sub).toMatchObject({ kind: "dir", size: null })
    expect(by["inside-link"]).toMatchObject({ kind: "file", size: 3, link: true })
    // Links out of the folder are shown as "other" without their target's size.
    expect(by["escape-file"]).toMatchObject({ kind: "other", size: null, link: true })
    expect(by["escape-dir"]).toMatchObject({ kind: "other", link: true })
    expect(l.disk?.totalBytes).toBeGreaterThan(0)
    expect((await make().list("sub")).entries.map((e) => e.name)).toEqual(["b.txt"])
  })

  it("refuses traversal, absolute paths, links out of the folder, files and missing folders", async () => {
    const c = make()
    expect(await kindOf(c.list(".."))).toBe("INVALID")
    expect(await kindOf(c.list("../secreto"))).toBe("INVALID")
    expect(await kindOf(c.list("sub/../../secreto"))).toBe("INVALID")
    expect(await kindOf(c.list(outside))).toBe("INVALID")
    expect(await kindOf(c.list("%2e%2e"))).toBe("NOT_FOUND") // a literal name, never decoded twice
    expect(await kindOf(c.list("escape-dir"))).toBe("NOT_FOUND")
    expect(await kindOf(c.list("a.txt"))).toBe("INVALID")
    expect(await kindOf(c.list("nope"))).toBe("NOT_FOUND")
  })

  it("is UNAVAILABLE when the folder is missing or contains the data", async () => {
    fs.rmSync(root, { recursive: true })
    expect(await kindOf(make().list(""))).toBe("UNAVAILABLE")
    const bad = createFilesCore({
      config: { files: { enabled: true, dir: t.dir, maxUploadBytes: 1, deleteAdminOnly: false, extraEnabled: false, extraDir: "/nonexistent-extra", extraName: "Compartida", extraHint: "Segunda carpeta compartida" }, dataDir: path.join(t.dir, "data"), backupDir: "/x", captureDir: "/y", dbFile: "/x/db", appDir: "/z" },
      log: createNullLogger(), bus, audit,
    })
    expect(await kindOf(bad.list(""))).toBe("UNAVAILABLE")
  })
})

describe("mkdir / rename / move / remove", () => {
  it("creates folders group-writable (the umask of the service is 0027) and keeps the setgid bit", async () => {
    fs.chmodSync(root, 0o2775)
    const prev = process.umask(0o027)
    try {
      const r = await make().mkdir("", "nueva", actor, "ana")
      expect(r.path).toBe("nueva")
    } finally {
      process.umask(prev)
    }
    expect(fs.statSync(path.join(root, "nueva")).mode & 0o7777).toBe(0o2775)
    expect(audit.inputs.at(-1)).toMatchObject({ action: "files.mkdir", target: { type: "file", name: "nueva" }, detail: { path: "nueva" } })
    expect(bus.events.at(-1)?.event).toMatchObject({ type: "files.changed", dirs: [""], change: "mkdir", names: ["nueva"], byName: "ana" })
    expect(await kindOf(make().mkdir("", "nueva", actor, "ana"))).toBe("EXISTS")
    expect(await kindOf(make().mkdir("", "a/b", actor, "ana"))).toBe("INVALID")
    expect(await kindOf(make().mkdir("", "..", actor, "ana"))).toBe("INVALID")
    expect(await kindOf(make().mkdir("escape-dir", "x", actor, "ana"))).toBe("NOT_FOUND")
    expect(fs.readdirSync(outside)).toEqual(["auth-secret"])
  })

  it("renames within the folder, refusing clashes and bad names", async () => {
    const c = make()
    expect(await c.rename("sub/b.txt", "c.txt", actor, "ana")).toEqual({ path: "sub/c.txt" })
    expect(fs.existsSync(path.join(root, "sub", "c.txt"))).toBe(true)
    expect(audit.inputs.at(-1)).toMatchObject({ action: "files.rename", detail: { from: "sub/b.txt", to: "sub/c.txt" } })
    expect(await kindOf(c.rename("a.txt", "sub", actor, "ana"))).toBe("EXISTS")
    expect(await kindOf(c.rename("a.txt", "../x", actor, "ana"))).toBe("INVALID")
    expect(await kindOf(c.rename("../a.txt", "x", actor, "ana"))).toBe("INVALID")
    expect(await kindOf(c.rename("", "x", actor, "ana"))).toBe("INVALID")
    expect(await kindOf(c.rename("nope", "x", actor, "ana"))).toBe("NOT_FOUND")
    // Renaming a link renames the link, never its target outside.
    await c.rename("escape-file", "enlace", actor, "ana")
    expect(fs.lstatSync(path.join(root, "enlace")).isSymbolicLink()).toBe(true)
    expect(fs.readdirSync(outside)).toEqual(["auth-secret"])
  })

  it("moves entries between folders, never into themselves or over existing names", async () => {
    const c = make()
    fs.mkdirSync(path.join(root, "sub", "deep"))
    expect(await c.move(["a.txt"], "sub", actor, "ana")).toEqual({ moved: 1 })
    expect(fs.existsSync(path.join(root, "sub", "a.txt"))).toBe(true)
    expect(bus.events.at(-1)?.event).toMatchObject({ type: "files.changed", change: "move" })
    expect(new Set((bus.events.at(-1)?.event as { dirs: string[] }).dirs)).toEqual(new Set(["", "sub"]))
    expect(await kindOf(c.move(["sub"], "sub/deep", actor, "ana"))).toBe("INVALID")
    fs.writeFileSync(path.join(root, "a.txt"), "again")
    expect(await kindOf(c.move(["a.txt"], "sub", actor, "ana"))).toBe("EXISTS")
    expect(await kindOf(c.move(["a.txt"], "escape-dir", actor, "ana"))).toBe("NOT_FOUND")
    expect(await kindOf(c.move(["a.txt"], "..", actor, "ana"))).toBe("INVALID")
    expect(fs.readdirSync(outside)).toEqual(["auth-secret"])
  })

  it("deletes files, folders (recursively) and links (never what they point to)", async () => {
    const c = make()
    fs.mkdirSync(path.join(root, "sub", "deep"))
    fs.writeFileSync(path.join(root, "sub", "deep", "x"), "x")
    fs.symlinkSync(outside, path.join(root, "sub", "deep", "escape"))
    expect(await c.remove(["sub", "a.txt", "escape-file", "escape-dir"], actor, "ana")).toEqual({ removed: 4 })
    expect(fs.readdirSync(root).sort()).toEqual(["inside-link"])
    expect(fs.readFileSync(path.join(outside, "auth-secret"), "utf8")).toBe("top secret")
    const a = audit.inputs.at(-1)
    expect(a).toMatchObject({ action: "files.delete", detail: { count: 4 } })
    expect(await kindOf(c.remove([""], actor, "ana"))).toBe("INVALID")
    expect(await kindOf(c.remove(["../secreto"], actor, "ana"))).toBe("INVALID")
    expect(await kindOf(c.remove(["nope"], actor, "ana"))).toBe("NOT_FOUND")
  })
})

describe("uploads", () => {
  it("uploads in chunks to a hidden temporary file and commits it with mode 0664", async () => {
    const c = make()
    const prev = process.umask(0o027)
    try {
      const s = await c.uploadStart({ dir: "sub", name: "imagen.ub", size: 10, conflict: "fail" }, uploader)
      expect(temps(path.join(root, "sub"))).toEqual([`${UPLOAD_TEMP_PREFIX}${s.id}.part`])
      expect(await c.uploadChunk(s.id, "u1", 0, body("01234"))).toEqual({ received: 5, done: false, name: null, path: null })
      expect(await kindOf(c.uploadChunk(s.id, "u1", 0, body("xxxxx")))).toBe("OFFSET")
      expect(await kindOf(c.uploadChunk(s.id, "otro", 5, body("56789")))).toBe("NOT_FOUND")
      expect(await c.uploadChunk(s.id, "u1", 5, body("56789"))).toEqual({ received: 10, done: true, name: "imagen.ub", path: "sub/imagen.ub" })
    } finally {
      process.umask(prev)
    }
    const f = path.join(root, "sub", "imagen.ub")
    expect(fs.readFileSync(f, "utf8")).toBe("0123456789")
    expect(fs.statSync(f).mode & 0o777).toBe(0o664)
    expect(temps(path.join(root, "sub"))).toEqual([])
    expect(c.sessions()).toBe(0)
    expect(audit.inputs.at(-1)).toMatchObject({ action: "files.upload", outcome: "ok", actor: { name: "ana" }, detail: { path: "sub/imagen.ub", sizeBytes: 10 } })
    expect(bus.events.at(-1)?.event).toMatchObject({ type: "files.changed", dirs: ["sub"], change: "upload", names: ["imagen.ub"] })
  })

  it("handles empty files", async () => {
    expect(await upload(make(), "", "vacío.txt", "")).toMatchObject({ done: true, name: "vacío.txt" })
    expect(fs.statSync(path.join(root, "vacío.txt")).size).toBe(0)
  })

  it("conflicts: fail asks, rename keeps both, overwrite replaces (a file, never a folder)", async () => {
    const c = make()
    const e = await c.uploadStart({ dir: "", name: "a.txt", size: 1, conflict: "fail" }, uploader).catch((x: unknown) => x)
    expect(isDomainError(e) && e.details).toMatchObject({ files: "EXISTS", name: "a.txt" })
    expect(temps()).toEqual([])
    expect(await upload(c, "", "a.txt", "nuevo", "rename")).toMatchObject({ name: "a (1).txt", path: "a (1).txt" })
    expect(await upload(c, "", "a.txt", "otro", "rename")).toMatchObject({ name: "a (2).txt" })
    expect(fs.readFileSync(path.join(root, "a.txt"), "utf8")).toBe("aaa")
    expect(await upload(c, "", "a.txt", "reemplazo", "overwrite")).toMatchObject({ name: "a.txt" })
    expect(fs.readFileSync(path.join(root, "a.txt"), "utf8")).toBe("reemplazo")
    expect(audit.inputs.at(-1)).toMatchObject({ action: "files.upload", detail: { overwrite: true } })
    expect(await upload(c, "", "sub", "no soy carpeta", "overwrite")).toMatchObject({ name: "sub (1)" })
    expect(fs.statSync(path.join(root, "sub")).isDirectory()).toBe(true)
  })

  it("never replaces a file created while the upload was running ('fail' keeps both)", async () => {
    const c = make()
    const s = await c.uploadStart({ dir: "", name: "carrera.bin", size: Buffer.byteLength("mío"), conflict: "fail" }, uploader)
    fs.writeFileSync(path.join(root, "carrera.bin"), "de otro")
    expect(await c.uploadChunk(s.id, "u1", 0, body("mío"))).toMatchObject({ done: true, name: "carrera (1).bin" })
    expect(fs.readFileSync(path.join(root, "carrera.bin"), "utf8")).toBe("de otro")
  })

  it("RM_FILES_DELETE=admins also forbids replacing (overwrite) to non-administrators", async () => {
    const c = make({}, { deleteAdminOnly: true })
    const e = await c.uploadStart({ dir: "", name: "a.txt", size: 1, conflict: "overwrite" }, uploader).catch((x: unknown) => x)
    expect(isDomainError(e) && e.details?.files).toBe("FORBIDDEN")
    expect(await upload(c, "", "a.txt", "x", "rename")).toMatchObject({ name: "a (1).txt" })
    const admin = await c.uploadStart({ dir: "", name: "a.txt", size: 1, conflict: "overwrite" }, { ...uploader, isAdmin: true })
    await c.uploadChunk(admin.id, "u1", 0, body("z"))
    expect(fs.readFileSync(path.join(root, "a.txt"), "utf8")).toBe("z")
  })

  it("never tells users the path of the folder on the server", async () => {
    fs.rmSync(root, { recursive: true })
    const e = await make().list("").catch((x: unknown) => x)
    expect(isDomainError(e) && e.message).toMatch(/^La carpeta de archivos del servidor no existe/)
    expect(isDomainError(e) && e.message).not.toContain(t.dir)
    // Health (administrators) does get it.
    expect((await make().status()).problem).toContain(root)
  })

  it("works without hard links (check, then rename)", async () => {
    const c = make({ link: async () => { throw Object.assign(new Error("no"), { code: "EPERM" }) } })
    expect(await upload(c, "", "a.txt", "x", "rename")).toMatchObject({ name: "a (1).txt" })
    expect(await upload(c, "", "nuevo.txt", "x")).toMatchObject({ name: "nuevo.txt" })
    expect(temps()).toEqual([])
  })

  it("enforces the size limit, names, the target folder and the byte count", async () => {
    const c = make({}, { maxUploadBytes: 100 })
    const tooBig = await c.uploadStart({ dir: "", name: "grande.bin", size: 101, conflict: "fail" }, uploader).catch((x: unknown) => x)
    expect(isDomainError(tooBig) && tooBig.details?.files).toBe("TOO_LARGE")
    expect(isDomainError(tooBig) && tooBig.message).toMatch(/máximo es 100 B/)
    expect(await kindOf(c.uploadStart({ dir: "", name: "../x", size: 1, conflict: "fail" }, uploader))).toBe("INVALID")
    expect(await kindOf(c.uploadStart({ dir: "", name: `${UPLOAD_TEMP_PREFIX}x.part`, size: 1, conflict: "fail" }, uploader))).toBe("INVALID")
    expect(await kindOf(c.uploadStart({ dir: "../secreto", name: "x", size: 1, conflict: "fail" }, uploader))).toBe("INVALID")
    expect(await kindOf(c.uploadStart({ dir: "escape-dir", name: "x", size: 1, conflict: "fail" }, uploader))).toBe("NOT_FOUND")
    const s = await c.uploadStart({ dir: "", name: "justo.bin", size: 4, conflict: "fail" }, uploader)
    expect(await kindOf(c.uploadChunk(s.id, "u1", 0, body("12345")))).toBe("INVALID")
    expect(fs.readdirSync(outside)).toEqual(["auth-secret"])
    await c.stop()
  })

  it("refuses to start without room on the disk (with the reserve and the uploads in progress)", async () => {
    const c = make({ statfs: async () => ({ freeBytes: 1000, totalBytes: 10_000 }), reserveBytes: 100 })
    const a = await c.uploadStart({ dir: "", name: "uno.bin", size: 500, conflict: "fail" }, uploader)
    const e = await c.uploadStart({ dir: "", name: "dos.bin", size: 450, conflict: "fail" }, uploader).catch((x: unknown) => x)
    expect(isDomainError(e) && e.details?.files).toBe("NO_SPACE")
    expect(isDomainError(e) && e.message).toMatch(/No hay espacio en el disco del servidor \(quedan 1000 B y el archivo ocupa 450 B\)/)
    await c.uploadCancel(a.id, "u1")
    expect(temps()).toEqual([])
  })

  it("disk full while writing (ENOSPC): clear error, temporary file removed, audited as an error", async () => {
    let written = 0
    const c = make({
      openWrite: async () => new Writable({
        write(chunk: Buffer, _e, cb) {
          written += chunk.length
          if (written > 3) cb(Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" }))
          else cb()
        },
      }),
      statfs: async () => ({ freeBytes: 2 * 1024 ** 3, totalBytes: 4 * 1024 ** 3 }),
    })
    const s = await c.uploadStart({ dir: "", name: "lleno.bin", size: 8, conflict: "fail" }, uploader)
    // A request body that is still open (more data coming): it must survive the error.
    const src = new Readable({ read() {} })
    src.push(Buffer.from("1234"))
    src.push(Buffer.from("5678"))
    const e = await c.uploadChunk(s.id, "u1", 0, src).catch((x: unknown) => x)
    expect(isDomainError(e) && e.details?.files).toBe("NO_SPACE")
    expect(isDomainError(e) && e.message).toMatch(/^No hay espacio en el disco del servidor/)
    expect(temps()).toEqual([])
    expect(c.sessions()).toBe(0)
    expect(fs.existsSync(path.join(root, "lleno.bin"))).toBe(false)
    expect(audit.inputs.at(-1)).toMatchObject({ action: "files.upload", outcome: "error", detail: { reason: "no-space" } })
    // The request body is not destroyed: the HTTP layer can still drain it and answer.
    expect(src.destroyed).toBe(false)
    src.destroy()
  })

  it("an interrupted chunk keeps the session; the client resumes from `received`", async () => {
    const c = make()
    const s = await c.uploadStart({ dir: "", name: "corte.bin", size: 6, conflict: "fail" }, uploader)
    const broken = new Readable({ read() {} })
    const p = c.uploadChunk(s.id, "u1", 0, broken)
    broken.push(Buffer.from("abc"))
    setTimeout(() => broken.destroy(), 20)
    expect(await kindOf(p)).toBe("INTERNAL")
    expect(c.sessions()).toBe(1)
    expect(await c.uploadChunk(s.id, "u1", 0, body("abcdef"))).toMatchObject({ done: true })
    expect(fs.readFileSync(path.join(root, "corte.bin"), "utf8")).toBe("abcdef")
  })

  it("cancel and the idle sweep remove the temporary file; stale temporaries are removed at start", async () => {
    let clock = 1_000_000
    const c = make({ now: () => clock, sessionIdleMs: 1000, staleTempMs: 1000 })
    const a = await c.uploadStart({ dir: "", name: "x.bin", size: 5, conflict: "fail" }, uploader)
    await c.uploadCancel(a.id, "u1")
    expect(temps()).toEqual([])
    await c.uploadStart({ dir: "sub", name: "y.bin", size: 5, conflict: "fail" }, uploader)
    clock += 2000
    await c.sweep()
    expect(temps(path.join(root, "sub"))).toEqual([])
    expect(c.sessions()).toBe(0)
    // Left by a crashed run.
    const old = path.join(root, "sub", `${UPLOAD_TEMP_PREFIX}deadbeef.part`)
    fs.writeFileSync(old, "x")
    fs.utimesSync(old, new Date(0), new Date(0))
    const c2 = make({ staleTempMs: 1000 })
    await c2.start()
    for (let i = 0; i < 50 && fs.existsSync(old); i++) await new Promise((r) => setTimeout(r, 20))
    expect(fs.existsSync(old)).toBe(false)
    await c2.stop()
  })

  it("limits the uploads in progress per user", async () => {
    const c = make({ maxSessionsPerUser: 2 })
    await c.uploadStart({ dir: "", name: "1", size: 1, conflict: "fail" }, uploader)
    await c.uploadStart({ dir: "", name: "2", size: 1, conflict: "fail" }, uploader)
    expect(await kindOf(c.uploadStart({ dir: "", name: "3", size: 1, conflict: "fail" }, uploader))).toBe("BUSY")
    await c.stop()
    expect(temps()).toEqual([])
  })
})

describe("downloads", () => {
  it("opens regular files inside the folder only", async () => {
    const c = make()
    const d = await c.openDownload("sub/b.txt")
    expect(d).toMatchObject({ size: 2, name: "b.txt", path: "sub/b.txt" })
    await d.handle.close()
    const l = await c.openDownload("inside-link")
    expect(l.size).toBe(3)
    await l.handle.close()
    expect(await kindOf(c.openDownload("escape-file"))).toBe("NOT_FOUND")
    expect(await kindOf(c.openDownload("escape-dir/auth-secret"))).toBe("NOT_FOUND")
    expect(await kindOf(c.openDownload("../secreto/auth-secret"))).toBe("INVALID")
    expect(await kindOf(c.openDownload(path.join(outside, "auth-secret")))).toBe("INVALID")
    expect(await kindOf(c.openDownload("sub"))).toBe("INVALID")
    expect(await kindOf(c.openDownload(""))).toBe("INVALID")
  })

  it("never opens a FIFO (it would block)", async () => {
    const { execFileSync } = await import("node:child_process")
    try {
      execFileSync("mkfifo", [path.join(root, "tubo")])
    } catch {
      return // no mkfifo here
    }
    expect(await kindOf(make().openDownload("tubo"))).toBe("NOT_FOUND")
    expect((await make().list("")).entries.find((e) => e.name === "tubo")?.kind).toBe("other")
  })
})

describe("roots: reserved names and adoptFile (second folder)", () => {
  function extraCore() {
    return createFilesCore({
      config: {
        files: { enabled: true, dir: root, maxUploadBytes: 1024, deleteAdminOnly: false, extraEnabled: true, extraDir: root, extraName: "Compartida", extraHint: "Segunda carpeta compartida" },
        dataDir: path.join(t.dir, "data"), backupDir: path.join(t.dir, "data", "backups"), captureDir: path.join(t.dir, "data", "consoles"),
        dbFile: path.join(t.dir, "data", "relay-manager.db"), appDir: path.join(t.dir, "app"),
      },
      log: createNullLogger(), bus, audit, root: { id: "extra", dir: root, reserved: [".descargas"] },
    }, { reserveBytes: 0 })
  }
  it("publishes and audits with the root; importFile copies from a descriptor without clobbering", async () => {
    const c = extraCore()
    const work = path.join(t.dir, "data", "descargas", "job")
    fs.mkdirSync(work, { recursive: true })
    fs.writeFileSync(path.join(work, "a.txt"), "nuevo")
    const h = await fs.promises.open(path.join(work, "a.txt"), "r")
    const r = await c.importFile("", "a.txt", h, "ana").finally(() => h.close())
    expect(r).toEqual({ name: "a (1).txt", path: "a (1).txt", size: 5 })
    expect(fs.readFileSync(path.join(root, "a.txt"), "utf8")).toBe("aaa")
    expect(fs.readFileSync(path.join(root, "a (1).txt"), "utf8")).toBe("nuevo")
    expect(fs.statSync(path.join(root, "a (1).txt")).mode & 0o777).toBe(0o664)
    expect(fs.readdirSync(root).some((n) => n.startsWith(".rm-upload-"))).toBe(false)
    expect(bus.events.at(-1)?.event).toMatchObject({ type: "files.changed", root: "extra", dirs: [""], change: "upload", names: ["a (1).txt"] })
    // The reserved name at the top is refused as a destination name.
    const h2 = await fs.promises.open(path.join(work, "a.txt"), "r")
    expect(await kindOf(c.importFile("", ".descargas", h2, "ana").finally(() => h2.close()))).toBe("INVALID")
    await c.mkdir("sub", "otra", actor, "ana")
    expect(audit.inputs.at(-1)?.detail).toMatchObject({ root: "extra", path: "sub/otra" })
    expect((await c.list("")).entries.map((e) => e.name)).not.toContain(".descargas")
    expect(await kindOf(c.checkFolder(".descargas/job"))).toBe("NOT_FOUND")
    expect(await c.checkFolder("sub")).toBe("sub")
  })
})
