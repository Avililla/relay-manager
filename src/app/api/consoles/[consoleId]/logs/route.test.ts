import fs from "node:fs"
import path from "node:path"
import { NextRequest } from "next/server"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { setRuntime } from "@/server/runtime/registry"
import type { AuthUser } from "@/server/runtime/types"
import { createTestDb, fakeAudit, fakeRuntime, withTempDir, type TestDb } from "../../../../../../test/helpers"
import { GET as listGET } from "./route"
import { GET as fileGET } from "./[file]/route"

const state = vi.hoisted(() => ({ user: null as AuthUser | null }))
vi.mock("@/server/authz", () => ({ getAuthUser: async () => state.user }))

const user = (over: Partial<AuthUser> = {}): AuthUser => ({
  id: "u1", username: "ana", name: "Ana", isAdmin: false, roleIds: [], mustChangePassword: false, sessionVersion: 1, ...over,
})

let db: TestDb
let tmp: { dir: string; cleanup: () => void }
let consoleId: string
let hiddenId: string
let audit: ReturnType<typeof fakeAudit>

beforeAll(async () => {
  db = await createTestDb()
  tmp = withTempDir("rm-logs-")
  const role = await db.prisma.role.create({ data: { name: "R" } })
  const eq = await db.prisma.equipment.create({ data: { name: "Equipo A #07" } })
  const hidden = await db.prisma.equipment.create({ data: { name: "Oculto", roles: { connect: [{ id: role.id }] } } })
  consoleId = (await db.prisma.serialConsole.create({ data: { equipmentId: eq.id, position: 0, key: "UART0", label: "UART0" } })).id
  hiddenId = (await db.prisma.serialConsole.create({ data: { equipmentId: hidden.id, position: 0, key: "UART1", label: "UART1" } })).id
  const dir = path.join(tmp.dir, consoleId)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "2026-09-23.log"), "[2026-09-23T10:00:00.000Z] hola\n")
  fs.writeFileSync(path.join(dir, "2026-09-23.input.log"), '[2026-09-23T10:00:00.000Z] >>> ana: "secreto\\r"\n')
})
afterAll(async () => {
  await db.cleanup()
  tmp.cleanup()
})

beforeEach(() => {
  audit = fakeAudit()
  const rt = fakeRuntime({ prisma: db.prisma, audit })
  // Only the capture-file part of the console manager is exercised here.
  rt.serial.consoles.listCaptureFiles = async (id, opts) => {
    const names = fs.readdirSync(path.join(tmp.dir, id)).filter((n) => opts.includeInput || !n.includes(".input."))
    return names.map((name) => ({ name, date: "2026-09-23", sizeBytes: 1, compressed: false, modifiedAt: "2026-09-23T10:00:00.000Z", input: name.includes(".input.") }))
  }
  rt.serial.consoles.captureFilePath = (id, name) => {
    const p = path.join(tmp.dir, id, name)
    return fs.existsSync(p) ? p : null
  }
  setRuntime(rt)
  state.user = user()
})

const req = (p: string) => new NextRequest(`http://bench:3000${p}`, { headers: { "x-forwarded-for": "10.2.2.2" } })
const rc = (params: Record<string, string>) => ({ params: Promise.resolve(params) })

describe("GET /api/consoles/[consoleId]/logs", () => {
  it("lists the files of a visible console; .input.log only for admins", async () => {
    const res = await listGET(req(`/api/consoles/${consoleId}/logs`), rc({ consoleId }))
    expect(res.status).toBe(200)
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect((await res.json() as Array<{ name: string }>).map((f) => f.name)).toEqual(["2026-09-23.log"])
    state.user = user({ isAdmin: true })
    const admin = await listGET(req(`/api/consoles/${consoleId}/logs`), rc({ consoleId }))
    expect((await admin.json() as Array<{ name: string }>).map((f) => f.name).sort()).toEqual(["2026-09-23.input.log", "2026-09-23.log"])
  })

  it("invisible → 404; no session → 401; bad id → 400", async () => {
    expect((await listGET(req(`/api/consoles/${hiddenId}/logs`), rc({ consoleId: hiddenId }))).status).toBe(404)
    expect((await listGET(req("/api/consoles/a-b/logs"), rc({ consoleId: "a-b" }))).status).toBe(400)
    state.user = null
    expect((await listGET(req(`/api/consoles/${consoleId}/logs`), rc({ consoleId }))).status).toBe(401)
  })
})

describe("GET /api/consoles/[consoleId]/logs/[file]", () => {
  it("streams the file as an attachment and audits the download", async () => {
    const res = await fileGET(req(`/api/consoles/${consoleId}/logs/2026-09-23.log`), rc({ consoleId, file: "2026-09-23.log" }))
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8")
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="equipo-a-07_uart0_2026-09-23.log"; filename*=UTF-8''Equipo%20A%20%2307_UART0_2026-09-23.log`)
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect(await res.text()).toBe("[2026-09-23T10:00:00.000Z] hola\n")
    expect(audit.inputs[0]).toMatchObject({ action: "console.log.download", actor: { name: "ana", ip: "10.2.2.2" }, target: { type: "console", id: consoleId, name: "UART0" }, detail: { file: "2026-09-23.log" } })
  })

  it("a non-admin asking for an .input.log gets 404 (admins get it)", async () => {
    expect((await fileGET(req(""), rc({ consoleId, file: "2026-09-23.input.log" }))).status).toBe(404)
    state.user = user({ isAdmin: true })
    const res = await fileGET(req(""), rc({ consoleId, file: "2026-09-23.input.log" }))
    expect(res.status).toBe(200)
    expect(await res.text()).toContain("secreto")
  })

  it("a file that grows while it is downloaded sends exactly Content-Length bytes (the size measured at open)", async () => {
    const file = path.join(tmp.dir, consoleId, "2026-09-22.log")
    const first = "[2026-09-22T10:00:00.000Z] ñandú arrancando\n".repeat(2000)
    fs.writeFileSync(file, first)
    const res = await fileGET(req(""), rc({ consoleId, file: "2026-09-22.log" }))
    expect(res.status).toBe(200)
    const declared = Number(res.headers.get("content-length"))
    expect(declared).toBe(Buffer.byteLength(first))
    fs.appendFileSync(file, "[2026-09-22T10:00:01.000Z] más salida\n".repeat(5000))   // the console keeps printing
    const body = Buffer.from(await res.arrayBuffer())
    expect(body.length).toBe(declared)
    expect(body.toString("utf8")).toBe(first)
    expect(audit.inputs[0]).toMatchObject({ detail: { file: "2026-09-22.log", sizeBytes: declared } })
    fs.rmSync(file)
  })

  it("HEAD: the same headers, no body, not audited as a download", async () => {
    const res = await fileGET(new NextRequest(`http://bench:3000/api/consoles/${consoleId}/logs/2026-09-23.log`, { method: "HEAD" }), rc({ consoleId, file: "2026-09-23.log" }))
    expect(res.status).toBe(200)
    expect(res.body).toBeNull()
    expect(res.headers.get("content-length")).toBe(String(Buffer.byteLength("[2026-09-23T10:00:00.000Z] hola\n")))
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; /)
    expect(audit.inputs).toEqual([])
  })

  it("the body is exactly the measured size even when the file shrank below it: the stream errors, never pads", async () => {
    const file = path.join(tmp.dir, consoleId, "2026-09-20.log")
    fs.writeFileSync(file, "x".repeat(1000))
    const res = await fileGET(req(""), rc({ consoleId, file: "2026-09-20.log" }))
    fs.writeFileSync(file, "x".repeat(10))
    await expect(res.arrayBuffer()).rejects.toThrow()
    fs.rmSync(file)
  })

  it("an empty file → 200 with an empty body and Content-Length 0", async () => {
    const file = path.join(tmp.dir, consoleId, "2026-09-21.log")
    fs.writeFileSync(file, "")
    const res = await fileGET(req(""), rc({ consoleId, file: "2026-09-21.log" }))
    expect(res.status).toBe(200)
    expect(res.headers.get("content-length")).toBe("0")
    expect((await res.arrayBuffer()).byteLength).toBe(0)
    fs.rmSync(file)
  })

  it("filename* is a strict RFC 5987 ext-value (' ( ) * ! are percent-encoded)", async () => {
    const eq = await db.prisma.equipment.create({ data: { name: "Banco (B) 'Ñ'*!" } })
    const id = (await db.prisma.serialConsole.create({ data: { equipmentId: eq.id, position: 0, key: "UART1", label: "UART1" } })).id
    fs.mkdirSync(path.join(tmp.dir, id), { recursive: true })
    fs.writeFileSync(path.join(tmp.dir, id, "2026-09-23.log"), "x\n")
    const res = await fileGET(req(""), rc({ consoleId: id, file: "2026-09-23.log" }))
    const cd = res.headers.get("content-disposition") ?? ""
    const ext = /filename\*=UTF-8''(.*)$/.exec(cd)?.[1] ?? ""
    expect(ext).toMatch(/^[A-Za-z0-9%#$&+.^_`|~-]+$/)
    expect(decodeURIComponent(ext)).toContain("Banco (B) 'Ñ'*!")
    await res.arrayBuffer()
  })

  it("names outside the capture pattern → 400; missing file or invisible console → 404", async () => {
    expect((await fileGET(req(""), rc({ consoleId, file: "..%2F..%2Fetc%2Fpasswd" }))).status).toBe(400)
    expect((await fileGET(req(""), rc({ consoleId, file: "meta.json" }))).status).toBe(400)
    expect((await fileGET(req(""), rc({ consoleId, file: "2020-01-01.log" }))).status).toBe(404)
    expect((await fileGET(req(""), rc({ consoleId: hiddenId, file: "2026-09-23.log" }))).status).toBe(404)
    expect(audit.inputs).toEqual([])
  })
})
