import fs from "node:fs"
import path from "node:path"
import { NextRequest } from "next/server"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { setRuntime } from "@/server/runtime/registry"
import type { AuthUser } from "@/server/runtime/types"
import { fakeAudit, fakeRuntime, withTempDir } from "../../../../../test/helpers"
import { GET } from "./route"

const state = vi.hoisted(() => ({ user: null as AuthUser | null }))
vi.mock("@/server/authz", () => ({ getAuthUser: async () => state.user }))

const admin: AuthUser = { id: "adm", username: "jefa", name: "Jefa", isAdmin: true, roleIds: [], mustChangePassword: false, sessionVersion: 1 }
const NAME = "relay-manager-20260923T020000Z-daily.db"
let tmp: ReturnType<typeof withTempDir>
let audit: ReturnType<typeof fakeAudit>

beforeAll(() => {
  tmp = withTempDir("rm-backup-route-")
  fs.writeFileSync(path.join(tmp.dir, NAME), Buffer.from("SQLite format 3\0datos de prueba"))
})
afterAll(() => tmp.cleanup())
beforeEach(() => {
  state.user = admin
  audit = fakeAudit()
  const rt = fakeRuntime({ audit })
  rt.ops.backups.resolvePath = (name) => (name === NAME ? path.join(tmp.dir, name) : null)
  setRuntime(rt)
})

const get = (name: string) => GET(new NextRequest(`http://bench:3000/api/backups/${encodeURIComponent(name)}`, { headers: { "x-forwarded-for": "10.0.0.3" } }), { params: Promise.resolve({ name }) })

describe("GET /api/backups/[name] (§7.3)", () => {
  it("streams the file as an attachment and audits backup.download", async () => {
    const res = await get(NAME)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("application/octet-stream")
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="${NAME.toLowerCase()}"; filename*=UTF-8''${NAME}`)
    expect(res.headers.get("cache-control")).toBe("no-store")
    const body = Buffer.from(await res.arrayBuffer())
    expect(body.toString("latin1")).toContain("datos de prueba")
    expect(audit.inputs).toEqual([expect.objectContaining({
      action: "backup.download", actor: expect.objectContaining({ id: "adm", ip: "10.0.0.3" }),
      target: { type: "backup", id: NAME, name: NAME }, detail: { file: NAME, sizeBytes: body.length },
    })])
  })

  it("unknown names → 404, invalid names → 400, non-admins → 403", async () => {
    expect((await get("relay-manager-20260101T000000Z-manual.db")).status).toBe(404)
    expect((await get("../../etc/passwd")).status).toBe(400)
    state.user = { ...admin, isAdmin: false }
    expect((await get(NAME)).status).toBe(403)
    expect(audit.inputs.map((i) => i.action)).toEqual(["auth.denied"])
  })
})
