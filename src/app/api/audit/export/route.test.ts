import { NextRequest } from "next/server"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { createAuditService } from "@/server/audit/service"
import { createNullLogger } from "@/server/log"
import { setRuntime } from "@/server/runtime/registry"
import type { AuditService, AuthUser } from "@/server/runtime/types"
import { createTestDb, fakeRuntime, type TestDb } from "../../../../../test/helpers"
import { GET } from "./route"

const state = vi.hoisted(() => ({ user: null as AuthUser | null }))
vi.mock("@/server/authz", () => ({ getAuthUser: async () => state.user }))

const admin: AuthUser = { id: "adm", username: "jefa", name: "Jefa", isAdmin: true, roleIds: [], mustChangePassword: false, sessionVersion: 1 }
let db: TestDb
let audit: AuditService

beforeAll(async () => { db = await createTestDb() })
afterAll(async () => { await db.cleanup() })
beforeEach(async () => {
  state.user = admin
  audit = createAuditService({ prisma: db.prisma, log: createNullLogger() })
  setRuntime(fakeRuntime({ prisma: db.prisma, audit }))
})

const get = (qs = "") => GET(new NextRequest(`http://bench:3000/api/audit/export${qs}`, { headers: { "x-forwarded-for": "10.0.0.9" } }), { params: Promise.resolve({}) })

describe("GET /api/audit/export (§7.3)", () => {
  it("streams a BOM-prefixed ;-separated CSV and neutralises formula cells", async () => {
    await audit.recordNow({ actor: { kind: "user", id: "x", name: "=HYPERLINK(\"http://evil\";\"clic\")", ip: "10.0.0.1" }, action: "auth.login.fail", outcome: "denied", detail: { username: "@SUM(1+1)" } })
    await audit.recordNow({ actor: { kind: "user", id: "y", name: "ana", ip: "10.0.0.2" }, action: "reservation.reserve", equipment: { id: "e1", name: "+EQ;1" }, target: { type: "equipment", id: "e1", name: "-menos" } })
    await audit.recordNow({ actor: { kind: "system", id: null, name: "\tTAB" }, action: "system.start", detail: { note: "\rCR" } })
    const res = await get()
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8")
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="auditoria-\d{4}-\d{2}-\d{2}\.csv"; filename\*=UTF-8''auditoria-/)
    expect(res.headers.get("cache-control")).toBe("no-store")
    const bytes = new Uint8Array(await res.arrayBuffer())
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    const text = new TextDecoder().decode(bytes.slice(3))
    const lines = text.split("\r\n")
    expect(lines[0]).toBe("fecha_utc;usuario;accion;resultado;equipo;objetivo;ip;detalle")
    // Newest first. The system row: a TAB-leading actor name is neutralised.
    expect(lines[1]).toContain(";'\tTAB;system.start;ok;")
    expect(lines[2]).toContain(";ana;reservation.reserve;ok;\"'+EQ;1\";")
    expect(lines[2]).toContain("equipment:-menos")
    // A username starting with "=" is exported with a leading apostrophe and RFC 4180 quoting.
    expect(lines[3]).toContain(";\"'=HYPERLINK(\"\"http://evil\"\";\"\"clic\"\")\";auth.login.fail;denied;")
    // The export itself is audited with the filters.
    await audit.flush()
    const rows = await db.prisma.auditEvent.findMany({ where: { action: "audit.export" } })
    expect(rows).toHaveLength(1)
    expect(rows[0].ip).toBe("10.0.0.9")
  })

  it("applies the filters and refuses non-admins", async () => {
    const res = await get("?action=reservation.reserve")
    const text = (await res.text()).replace(/^﻿/, "")
    expect(text.split("\r\n").filter(Boolean).slice(1).every((l) => l.includes(";reservation.reserve;"))).toBe(true)
    state.user = { ...admin, isAdmin: false }
    expect((await get()).status).toBe(403)
    expect((await get("?outcome=nope")).status).toBe(403)
    state.user = admin
    expect((await get("?outcome=nope")).status).toBe(400)
  })
})
