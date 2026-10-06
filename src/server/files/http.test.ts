import { spawnSync } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import http, { type IncomingMessage } from "node:http"
import type { AddressInfo } from "node:net"
import path from "node:path"
import { Readable, Writable } from "node:stream"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { FILES_CHUNK_MAX_BYTES } from "@/lib/contracts/files"
import { createNullLogger } from "@/server/log"
import { createRequestListener } from "@/server/http/listen"
import type { AuthenticatedSession, AuthUser } from "@/server/runtime/types"
import { fakeAudit, fakeBus, testConfig, withTempDir } from "../../../test/helpers"
import type { FilesInternals } from "./core"
import { createFilesServices } from "."
import { parseRange } from "./http"

const USERS: Record<string, AuthUser> = {
  ana: { id: "u1", username: "ana", name: "Ana", isAdmin: false, roleIds: [], mustChangePassword: false, sessionVersion: 1 },
  nuevo: { id: "u2", username: "nuevo", name: "Nuevo", isAdmin: false, roleIds: [], mustChangePassword: true, sessionVersion: 1 },
}

let t: { dir: string; cleanup: () => void }
let root: string
let server: http.Server | null = null
let base: string
let audit: ReturnType<typeof fakeAudit>

async function start(opts: { internals?: FilesInternals; enabled?: boolean; maxUploadBytes?: number } = {}) {
  audit = fakeAudit()
  const config = testConfig({
    dataDir: path.join(t.dir, "data"), backupDir: path.join(t.dir, "data", "b"), captureDir: path.join(t.dir, "data", "c"),
    files: { enabled: opts.enabled ?? true, dir: root, maxUploadBytes: opts.maxUploadBytes ?? 1024 ** 3, deleteAdminOnly: false, extraEnabled: false, extraDir: "/nonexistent-extra", extraName: "Compartida", extraHint: "Segunda carpeta compartida" },
  })
  const svc = createFilesServices({
    config, log: createNullLogger(), bus: fakeBus(), audit,
    prisma: undefined as never, settings: undefined as never,
    authenticate: async (req: IncomingMessage): Promise<AuthenticatedSession | null> => {
      const m = /sid=(\w+)/.exec(String(req.headers.cookie ?? ""))
      const user = m ? USERS[m[1]] : undefined
      return user ? { user, sv: 1, loginAt: Date.now() } : null
    },
  }, { reserveBytes: 0, ...opts.internals })
  const srv = http.createServer()
  server = srv
  srv.requestTimeout = 60_000
  const cfgRef = { tls: null, port: 0 }
  srv.on("request", createRequestListener(cfgRef, (req, res) => {
    if (!svc.handleRequest(req, res)) {
      res.writeHead(418)
      res.end()
    }
  }))
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r))
  cfgRef.port = (srv.address() as AddressInfo).port
  base = `http://127.0.0.1:${cfgRef.port}`
  return svc
}

const cookie = (u = "ana") => ({ cookie: `sid=${u}` })
const origin = () => ({ origin: base })
const get = (p: string, headers: Record<string, string> = cookie()) => fetch(`${base}${p}`, { headers })
const q = (p: string) => encodeURIComponent(p)

async function startUpload(name: string, size: number, dir = "", conflict = "fail", headers: Record<string, string> = { ...cookie(), ...origin() }) {
  return fetch(`${base}/api/files/upload`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ dir, name, size, conflict }) })
}
async function putChunk(id: string, offset: number, data: Buffer | Readable, length?: number): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}/api/files/upload/${id}?offset=${offset}`, {
      method: "PUT", headers: { ...cookie(), ...origin(), "content-type": "application/octet-stream", "content-length": String(length ?? (data as Buffer).length) },
    }, (res) => {
      const chunks: Buffer[] = []
      res.on("data", (c: Buffer) => chunks.push(c))
      res.on("end", () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString() || "{}") as Record<string, unknown> }))
    })
    req.on("error", reject)
    if (Buffer.isBuffer(data)) req.end(data)
    else data.pipe(req)
  })
}

beforeEach(() => {
  t = withTempDir("rm-files-http-")
  root = path.join(t.dir, "tftp")
  fs.mkdirSync(path.join(root, "sub"), { recursive: true })
  fs.mkdirSync(path.join(t.dir, "secreto"))
  fs.writeFileSync(path.join(t.dir, "secreto", "auth-secret"), "top secret")
  fs.symlinkSync(path.join(t.dir, "secreto"), path.join(root, "escape"))
  fs.writeFileSync(path.join(root, "número 1.bin"), Buffer.from("0123456789"))
})
async function stopServer(): Promise<void> {
  const s = server
  server = null
  if (!s) return
  s.closeAllConnections()
  await new Promise<void>((r) => s.close(() => r()))
}
afterEach(async () => {
  await stopServer()
  t.cleanup()
})

describe("parseRange", () => {
  it("parses one range and rejects unsatisfiable ones", () => {
    expect(parseRange(undefined, 10)).toBeNull()
    expect(parseRange("bytes=0-4", 10)).toEqual({ start: 0, end: 4 })
    expect(parseRange("bytes=5-", 10)).toEqual({ start: 5, end: 9 })
    expect(parseRange("bytes=-3", 10)).toEqual({ start: 7, end: 9 })
    expect(parseRange("bytes=8-100", 10)).toEqual({ start: 8, end: 9 })
    expect(parseRange("bytes=10-", 10)).toBe("unsatisfiable")
    expect(parseRange("bytes=5-2", 10)).toBe("unsatisfiable")
    expect(parseRange("bytes=0-1,4-5", 10)).toBeNull() // several ranges: the whole file
    expect(parseRange("items=0-1", 10)).toBeNull()
  })
})

describe("files HTTP API", () => {
  it("requires a session, a changed password and (for writes) the same Origin; 404 when disabled", async () => {
    await start()
    expect((await get("/api/files/list?path=", {})).status).toBe(401)
    const nuevo = await get("/api/files/list?path=", cookie("nuevo"))
    expect(nuevo.status).toBe(403)
    expect(((await nuevo.json()) as { message: string }).message).toMatch(/cambiar tu contraseña/)
    const noOrigin = await startUpload("x", 1, "", "fail", cookie())
    expect(noOrigin.status).toBe(403)
    expect(await noOrigin.text()).toContain("FORBIDDEN_ORIGIN")
    const evil = await startUpload("x", 1, "", "fail", { ...cookie(), origin: "http://evil.example" })
    expect(evil.status).toBe(403)
    expect((await get("/api/other")).status).toBe(418) // not ours: Next would serve it
    await stopServer()
    await start({ enabled: false })
    const off = await get("/api/files/list?path=")
    expect(off.status).toBe(404)
    expect(((await off.json()) as { error: string }).error).toBe("DISABLED")
  })

  it("lists a folder as JSON", async () => {
    await start()
    const r = await get("/api/files/list?path=")
    expect(r.status).toBe(200)
    expect(r.headers.get("cache-control")).toBe("no-store")
    const body = (await r.json()) as { path: string; entries: Array<{ name: string; kind: string }> }
    expect(body.entries.map((e) => `${e.name}:${e.kind}`).sort()).toEqual(["escape:other", "número 1.bin:file", "sub:dir"])
  })

  it("never serves anything outside the folder (traversal, encoded, absolute, symlink)", async () => {
    await start()
    const attempts = [
      "/api/files/download?path=..%2Fsecreto%2Fauth-secret",
      "/api/files/download?path=%2e%2e%2fsecreto%2fauth-secret",
      "/api/files/download?path=%252e%252e%252fsecreto%252fauth-secret",
      "/api/files/download?path=sub%2F..%2F..%2Fsecreto%2Fauth-secret",
      `/api/files/download?path=${q(path.join(t.dir, "secreto", "auth-secret"))}`,
      "/api/files/download?path=escape%2Fauth-secret",
      "/api/files/download?path=escape",
      "/api/files/download?path=sub%00x",
      "/api/files/list?path=..",
      "/api/files/list?path=escape",
      "/api/files/archive?format=zip&dir=&name=escape",
      "/api/files/archive?format=tar.gz&dir=&name=escape",
      "/api/files/archive?format=zip&dir=..&name=secreto",
      "/api/files/archive?format=tar.gz&dir=escape",
      "/api/files/archive?format=zip&dir=&name=..%2Fsecreto",
      "/api/files/archive?format=tar.gz&dir=&name=%2Ftmp",
      "/api/files/../../secreto/auth-secret",
    ]
    for (const a of attempts) {
      const r = await get(a)
      const text = await r.text()
      expect(text, a).not.toContain("top secret")
      if (!/name=escape$/.test(a)) expect(r.status, a).toBeGreaterThanOrEqual(400)
    }
  })

  it("downloads with Content-Disposition, Content-Length, Range, If-Range and HEAD; audits once", async () => {
    await start()
    const p = `/api/files/download?path=${q("número 1.bin")}`
    const full = await get(p)
    expect(full.status).toBe(200)
    expect(Buffer.from(await full.arrayBuffer()).toString()).toBe("0123456789")
    expect(full.headers.get("content-length")).toBe("10")
    expect(full.headers.get("accept-ranges")).toBe("bytes")
    expect(full.headers.get("content-type")).toBe("application/octet-stream")
    expect(full.headers.get("content-disposition")).toBe(`attachment; filename="numero_1.bin"; filename*=UTF-8''n%C3%BAmero%201.bin`)
    const etag = full.headers.get("etag") ?? ""
    const part = await get(p, { ...cookie(), range: "bytes=3-6" })
    expect(part.status).toBe(206)
    expect(part.headers.get("content-range")).toBe("bytes 3-6/10")
    expect(await part.text()).toBe("3456")
    const tail = await get(p, { ...cookie(), range: "bytes=7-", "if-range": etag })
    expect(tail.status).toBe(206)
    expect(await tail.text()).toBe("789")
    const changed = await get(p, { ...cookie(), range: "bytes=7-", "if-range": 'W/"otro"' })
    expect(changed.status).toBe(200)
    expect(await changed.text()).toBe("0123456789")
    const bad = await get(p, { ...cookie(), range: "bytes=20-" })
    expect(bad.status).toBe(416)
    expect(bad.headers.get("content-range")).toBe("bytes */10")
    const head = await fetch(`${base}${p}`, { method: "HEAD", headers: cookie() })
    expect(head.status).toBe(200)
    expect(head.headers.get("content-length")).toBe("10")
    const downloads = audit.inputs.filter((i) => i.action === "files.download")
    // Full GET, the If-Range fallback (200) — not the partial ones, nor HEAD.
    expect(downloads.length).toBe(2)
    expect(downloads[0]).toMatchObject({ actor: { name: "ana" }, detail: { path: "número 1.bin", sizeBytes: 10 } })
    expect((await get("/api/files/download?path=sub")).status).toBe(400)
    expect((await get("/api/files/download?path=nada")).status).toBe(404)
  })

  it("uploads in chunks; conflicts are 409 with a Spanish message; offsets are enforced", async () => {
    await start()
    const data = crypto.randomBytes(300_000)
    const s = await startUpload("firmware.bin", data.length, "sub")
    expect(s.status).toBe(201)
    const { id, chunkMaxBytes } = (await s.json()) as { id: string; chunkMaxBytes: number }
    expect(chunkMaxBytes).toBe(FILES_CHUNK_MAX_BYTES)
    expect(await putChunk(id, 0, data.subarray(0, 100_000))).toMatchObject({ status: 200, json: { received: 100_000, done: false } })
    const wrong = await putChunk(id, 0, data.subarray(0, 10))
    expect(wrong).toMatchObject({ status: 409, json: { error: "OFFSET", received: 100_000 } })
    expect(await putChunk(id, 100_000, data.subarray(100_000))).toMatchObject({ status: 200, json: { received: 300_000, done: true, name: "firmware.bin", path: "sub/firmware.bin" } })
    expect(fs.readFileSync(path.join(root, "sub", "firmware.bin")).equals(data)).toBe(true)
    const again = await startUpload("firmware.bin", 1, "sub")
    expect(again.status).toBe(409)
    expect(await again.json()).toMatchObject({ error: "EXISTS", message: "Ya existe «firmware.bin» en esta carpeta.", name: "firmware.bin" })
    const kept = await (await startUpload("firmware.bin", 1, "sub", "rename")).json() as { id: string }
    expect(await putChunk(kept.id, 0, Buffer.from("x"))).toMatchObject({ json: { name: "firmware (1).bin" } })
    const gone = await putChunk("0".repeat(32), 0, Buffer.from("x"))
    expect(gone.status).toBe(404)
    // Cancel.
    const c = await (await startUpload("cancelado.bin", 10)).json() as { id: string }
    const del = await fetch(`${base}/api/files/upload/${c.id}`, { method: "DELETE", headers: { ...cookie(), ...origin() } })
    expect(del.status).toBe(204)
    expect(fs.readdirSync(root).filter((n) => n.startsWith(".rm-upload-"))).toEqual([])
  })

  it("refuses files over RM_FILES_MAX_UPLOAD_MB before any data is sent", async () => {
    await start({ maxUploadBytes: 1024 })
    const r = await startUpload("grande.iso", 2048)
    expect(r.status).toBe(413)
    expect(((await r.json()) as { message: string }).message).toMatch(/ocupa 2 KiB y el máximo es 1 KiB/)
  })

  it("a full disk mid-chunk answers 507 with a Spanish message (the connection survives) and cleans up", async () => {
    let n = 0
    await start({
      internals: {
        openWrite: async () => new Writable({
          write(chunk: Buffer, _e, cb) {
            n += chunk.length
            cb(n > 256 * 1024 ? Object.assign(new Error("ENOSPC"), { code: "ENOSPC" }) : null)
          },
        }),
      },
    })
    const data = crypto.randomBytes(2 * 1024 * 1024)
    const { id } = (await (await startUpload("lleno.bin", data.length)).json()) as { id: string }
    const r = await putChunk(id, 0, data)
    expect(r.status).toBe(507)
    expect(r.json).toMatchObject({ error: "NO_SPACE" })
    expect(String(r.json.message)).toMatch(/^No hay espacio en el disco del servidor/)
    expect(fs.readdirSync(root).filter((x) => x.startsWith(".rm-upload-"))).toEqual([])
    // The session is gone.
    expect((await putChunk(id, 0, Buffer.from("x"))).status).toBe(404)
  })

  it("downloads a folder or a selection as .zip and .tar.gz (round trip with unzip and tar)", async () => {
    await start()
    const long = `${"nombre-largo-".repeat(9)}ñ.bin`
    fs.mkdirSync(path.join(root, "sub", "deep", "vacía", "más"), { recursive: true })
    fs.writeFileSync(path.join(root, "sub", "deep", "c.txt"), "ccc")
    fs.writeFileSync(path.join(root, "sub", long), crypto.randomBytes(100_000))
    fs.writeFileSync(path.join(root, "sub", "run.sh"), "#!/bin/sh\n", { mode: 0o755 })
    fs.chmodSync(path.join(root, "sub", "run.sh"), 0o755)
    fs.utimesSync(path.join(root, "sub", "deep", "c.txt"), new Date("2025-01-02T03:04:05Z"), new Date("2025-01-02T03:04:05Z"))
    fs.symlinkSync(path.join(t.dir, "secreto", "auth-secret"), path.join(root, "sub", "fuera"))
    fs.symlinkSync("deep/c.txt", path.join(root, "sub", "dentro"))
    const hash = (p: string) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex")
    for (const format of ["zip", "tar.gz"] as const) {
      const r = await get(`/api/files/archive?format=${format}&dir=&name=sub`)
      expect(r.status).toBe(200)
      expect(r.headers.get("content-type")).toBe(format === "zip" ? "application/zip" : "application/gzip")
      expect(r.headers.get("content-disposition")).toBe(`attachment; filename="sub.${format}"; filename*=UTF-8''sub.${format}`)
      const file = path.join(t.dir, `sub.${format}`)
      fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()))
      const x = path.join(t.dir, `x-${format}`)
      fs.mkdirSync(x)
      const ex = format === "zip"
        ? spawnSync("unzip", ["-q", file, "-d", x], { encoding: "utf8" })
        : spawnSync("tar", ["-xzpf", file, "-C", x], { encoding: "utf8" })
      expect(ex.status, ex.stderr).toBe(0)
      expect(hash(path.join(x, "sub", long))).toBe(hash(path.join(root, "sub", long)))
      expect(fs.readFileSync(path.join(x, "sub", "deep", "c.txt"), "utf8")).toBe("ccc")
      expect(fs.readFileSync(path.join(x, "sub", "dentro"), "utf8")).toBe("ccc") // a link inside: its contents
      expect(fs.statSync(path.join(x, "sub", "deep", "vacía", "más")).isDirectory()).toBe(true)
      expect(fs.statSync(path.join(x, "sub", "run.sh")).mode & 0o111).not.toBe(0)
      if (format === "tar.gz") expect(fs.statSync(path.join(x, "sub", "deep", "c.txt")).mtime.toISOString()).toBe("2025-01-02T03:04:05.000Z")
      // The link out of the folder is not followed: it is listed in _OMITIDOS.txt instead.
      expect(fs.existsSync(path.join(x, "sub", "fuera"))).toBe(false)
      const report = fs.readFileSync(path.join(x, "_OMITIDOS.txt"), "utf8")
      expect(report).toContain("sub/fuera: enlace a algo fuera de la carpeta de archivos")
      expect(JSON.stringify(fs.readdirSync(x, { recursive: true }))).not.toContain("auth-secret")
    }
    // A selection of two entries, named after the folder shown.
    const sel = await get(`/api/files/archive?format=tar.gz&dir=sub&name=deep&name=run.sh`)
    expect(sel.headers.get("content-disposition")).toContain('filename="sub.tar.gz"')
    const root2 = await get(`/api/files/archive?format=zip&dir=&name=sub&name=${q("número 1.bin")}`)
    expect(root2.headers.get("content-disposition")).toContain('filename="archivos.zip"')
    expect((await get("/api/files/archive?format=rar&dir=&name=sub")).status).toBe(400)
    expect((await get("/api/files/archive?format=zip&dir=&name=nada")).status).toBe(404)
    expect(audit.inputs.filter((i) => i.action === "files.download").map((i) => i.detail?.format)).toEqual(["zip", "tar.gz", "tar.gz", "zip"])
  })

  it("stops reading files when the client aborts an archive download", { timeout: 60_000 }, async () => {
    await start()
    fs.mkdirSync(path.join(root, "big"))
    const block = crypto.randomBytes(8 * 1024 * 1024)
    for (let i = 0; i < 10; i++) fs.writeFileSync(path.join(root, "big", `f${i}.bin`), block)
    const realOpen = fs.promises.open
    let opened = 0
    const spy = vi.spyOn(fs.promises, "open").mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
      if (/\/f\d\.bin$/.test(String(p))) opened++ // opened through the folder's descriptor (/proc/self/fd/<n>/f3.bin)
      return (realOpen as (...a: unknown[]) => Promise<fs.promises.FileHandle>)(p, ...rest)
    }) as typeof fs.promises.open)
    const openFds = () => fs.readdirSync("/proc/self/fd").filter((fd) => {
      try { return fs.readlinkSync(`/proc/self/fd/${fd}`).startsWith(path.join(root, "big")) } catch { return false }
    }).length
    for (const format of ["zip", "tar.gz"] as const) {
      let got = 0
      await new Promise<void>((resolve, reject) => {
        const req = http.get(`${base}/api/files/archive?format=${format}&dir=&name=big`, { headers: cookie() }, (res) => {
          res.on("data", (c: Buffer) => {
            got += c.length
            if (got > 2 * 1024 * 1024) { req.destroy(); resolve() }
          })
          res.on("error", () => resolve())
        })
        req.on("error", (e) => (got > 0 ? resolve() : reject(e)))
      })
      for (let i = 0; i < 50 && openFds() > 0; i++) await new Promise((r) => setTimeout(r, 50))
      expect(openFds(), format).toBe(0)
      await new Promise((r) => setTimeout(r, 300))
      // 80 MiB in 10 files; the client left after 2 MiB: the server opened only the first file or two.
      expect(opened, format).toBeGreaterThan(0)
      expect(opened, format).toBeLessThanOrEqual(3)
      opened = 0
    }
    spy.mockRestore()
  })

  it("streams a 200 MB upload and download without holding the file in memory", { timeout: 120_000 }, async () => {
    await start()
    const SIZE = 200 * 1024 * 1024
    const block = crypto.randomBytes(1024 * 1024)
    const hashUp = crypto.createHash("sha256")
    const baseline = process.memoryUsage()
    let peak = 0
    const sample = setInterval(() => {
      const m = process.memoryUsage()
      peak = Math.max(peak, m.rss - baseline.rss)
    }, 20)
    try {
      const { id } = (await (await startUpload("grande.img", SIZE)).json()) as { id: string }
      let offset = 0
      while (offset < SIZE) {
        const len = Math.min(FILES_CHUNK_MAX_BYTES, SIZE - offset)
        const start = offset
        const src = Readable.from((function* () {
          for (let sent = 0; sent < len; sent += block.length) {
            // A different block every MiB: the hash covers every byte.
            const b = Buffer.from(block)
            b.writeUInt32LE(start + sent, 0)
            const piece = b.subarray(0, Math.min(block.length, len - sent))
            hashUp.update(piece)
            yield piece
          }
        })())
        const r = await putChunk(id, offset, src, len)
        expect(r.status).toBe(200)
        offset += len
        if (offset === SIZE) expect(r.json).toMatchObject({ done: true, name: "grande.img" })
      }
      expect(fs.statSync(path.join(root, "grande.img")).size).toBe(SIZE)
      // Download, hashing while it streams.
      const hashDown = crypto.createHash("sha256")
      let got = 0
      await new Promise<void>((resolve, reject) => {
        http.get(`${base}/api/files/download?path=grande.img`, { headers: cookie() }, (res) => {
          expect(res.statusCode).toBe(200)
          res.on("data", (c: Buffer) => { hashDown.update(c); got += c.length })
          res.on("end", () => resolve())
          res.on("error", reject)
        }).on("error", reject)
      })
      expect(got).toBe(SIZE)
      expect(hashDown.digest("hex")).toBe(hashUp.digest("hex"))
    } finally {
      clearInterval(sample)
    }
    // Client and server share this process: 200 MB went through it twice; far less than that stays resident.
    expect(peak).toBeLessThan(120 * 1024 * 1024)
  })
})
