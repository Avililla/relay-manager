import { NextRequest } from "next/server"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import type { Page } from "@/lib/contracts/common"
import type { AuditEventDTO } from "@/lib/contracts/audit"
import { createAuditService } from "@/server/audit/service"
import { createNullLogger } from "@/server/log"
import { setRuntime } from "@/server/runtime/registry"
import type { AuthUser } from "@/server/runtime/types"
import { createTestDb, fakeRuntime, type TestDb } from "../../../../../../test/helpers"
import { GET } from "./route"

const state = vi.hoisted(() => ({ user: null as AuthUser | null }))
vi.mock("@/server/authz", () => ({ getAuthUser: async () => state.user }))

const user = (over: Partial<AuthUser> = {}): AuthUser => ({ id: "u1", username: "ana", name: "Ana", isAdmin: false, roleIds: [], mustChangePassword: false, sessionVersion: 1, ...over })
let db: TestDb
let eqId: string
let hiddenId: string

beforeAll(async () => {
  db = await createTestDb()
  const audit = createAuditService({ prisma: db.prisma, log: createNullLogger() })
  setRuntime(fakeRuntime({ prisma: db.prisma, audit }))
  const role = await db.prisma.role.create({ data: { name: "Secreto" } })
  const eq = await db.prisma.equipment.create({ data: { name: "EQ-1" } })
  const hidden = await db.prisma.equipment.create({ data: { name: "EQ-2", roles: { connect: [{ id: role.id }] } } })
  eqId = eq.id
  hiddenId = hidden.id
  for (let i = 0; i < 55; i++) {
    await audit.recordNow({ actor: { kind: "user", id: "u9", name: "berta", ip: `10.0.0.${i}` }, action: "reservation.renew", equipment: { id: eq.id, name: "EQ-1" } })
  }
  await audit.recordNow({ actor: { kind: "user", id: "u9", name: "berta", ip: "10.0.0.99" }, action: "reservation.reserve", equipment: { id: hidden.id, name: "EQ-2" } })
})
afterAll(async () => { await db.cleanup() })
beforeEach(() => { state.user = user() })

const get = (id: string, qs = "") => GET(new NextRequest(`http://bench:3000/api/equipment/${id}/activity${qs}`), { params: Promise.resolve({ id }) })

describe("GET /api/equipment/[id]/activity (§7.3)", () => {
  it("pages 50 at a time with an id cursor and hides IPs from non-admins", async () => {
    const res = await get(eqId)
    expect(res.status).toBe(200)
    const page = await res.json() as Page<AuditEventDTO>
    expect(page.items).toHaveLength(50)
    expect(page.items.every((e) => e.ip === null && e.equipmentId === eqId)).toBe(true)
    expect(page.nextCursor).not.toBeNull()
    const next = await (await get(eqId, `?cursor=${page.nextCursor}`)).json() as Page<AuditEventDTO>
    expect(next.items).toHaveLength(5)
    expect(next.nextCursor).toBeNull()
  })

  it("admins see IPs", async () => {
    state.user = user({ isAdmin: true })
    const page = await (await get(eqId)).json() as Page<AuditEventDTO>
    expect(page.items[0].ip).toMatch(/^10\.0\.0\./)
  })

  it("invisible or missing equipment → 404; bad params → 400", async () => {
    expect((await get(hiddenId)).status).toBe(404)
    expect((await get("doesnotexist")).status).toBe(404)
    expect((await get("bad-id!")).status).toBe(400)
    expect((await get(eqId, "?cursor=-1")).status).toBe(400)
  })
})
