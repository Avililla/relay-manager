import { beforeEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"
import { defineAction, definePublicAction } from "./define-action"
import { DomainError } from "@/server/errors"
import { setRuntime } from "@/server/runtime/registry"
import type { AuthUser } from "@/server/runtime/types"
import { fakeAudit, fakeRuntime } from "../../../test/helpers"

const state = vi.hoisted(() => ({ user: null as AuthUser | null }))
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-forwarded-for": "10.9.9.9" }) }))
vi.mock("@/server/authz", () => ({ getAuthUser: async () => state.user }))

const user = (over: Partial<AuthUser> = {}): AuthUser => ({
  id: "u1", username: "ana", name: "Ana", isAdmin: false, roleIds: [], mustChangePassword: false, sessionVersion: 1, ...over,
})
let audit: ReturnType<typeof fakeAudit>
beforeEach(() => {
  audit = fakeAudit()
  setRuntime(fakeRuntime({ audit }))
  state.user = user()
})

const Input = z.object({ name: z.string().min(2), rows: z.array(z.object({ key: z.string().regex(/^[A-Z]+$/) })) })

describe("defineAction", () => {
  it("runs the handler with ctx (fresh user, actor, socket ip)", async () => {
    const act = defineAction(Input, { auth: "user" }, async (input, ctx) => ({ got: input.name, ip: ctx.ip, actor: ctx.actor, hasRt: !!ctx.rt }))
    const r = await act({ name: "ok", rows: [] })
    expect(r).toEqual({ ok: true, data: { got: "ok", ip: "10.9.9.9", actor: { kind: "user", id: "u1", name: "ana", ip: "10.9.9.9" }, hasRt: true } })
  })
  it("no session → UNAUTHENTICATED (not audited)", async () => {
    state.user = null
    const r = await defineAction(Input, { auth: "user" }, async () => 1)({ name: "ok", rows: [] })
    expect(r).toMatchObject({ ok: false, error: { code: "UNAUTHENTICATED" } })
    expect(audit.inputs).toHaveLength(0)
  })
  it("mustChangePassword → PASSWORD_CHANGE_REQUIRED unless allowed; audited auth.denied", async () => {
    state.user = user({ mustChangePassword: true })
    const r = await defineAction(Input, { auth: "user" }, async () => 1)({ name: "ok", rows: [] })
    expect(r).toMatchObject({ ok: false, error: { code: "PASSWORD_CHANGE_REQUIRED" } })
    expect(audit.inputs[0]).toMatchObject({ action: "auth.denied", outcome: "denied", detail: { code: "PASSWORD_CHANGE_REQUIRED" } })
    const allowed = await defineAction(Input, { auth: "user", allowMustChangePassword: true }, async () => 1)({ name: "ok", rows: [] })
    expect(allowed).toEqual({ ok: true, data: 1 })
  })
  it("non-admin on an admin action → FORBIDDEN, audited auth.denied with the operation", async () => {
    const r = await defineAction(Input, { auth: "admin" }, async function createThing() { return 1 })({ name: "ok", rows: [] })
    expect(r).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } })
    expect(audit.inputs[0]).toMatchObject({ action: "auth.denied", outcome: "denied", actor: { id: "u1", ip: "10.9.9.9" }, detail: { code: "FORBIDDEN" } })
    expect(typeof (audit.inputs[0].detail as { operation: string }).operation).toBe("string")
  })
  it("handler FORBIDDEN is audited too", async () => {
    const r = await defineAction(Input, { auth: "user" }, async () => { throw new DomainError("FORBIDDEN", "No") })({ name: "ok", rows: [] })
    expect(r).toMatchObject({ ok: false, error: { code: "FORBIDDEN", message: "No" } })
    expect(audit.inputs.map((i) => i.action)).toEqual(["auth.denied"])
  })
  it("invalid input → VALIDATION with dotted fieldErrors", async () => {
    const r = await defineAction(Input, { auth: "user" }, async () => 1)({ name: "x", rows: [{ key: "OK" }, { key: "bad" }] })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe("VALIDATION")
      expect(Object.keys(r.error.fieldErrors ?? {}).sort()).toEqual(["name", "rows.1.key"])
      expect(r.error.message.length).toBeGreaterThan(0)
    }
  })
  it("schemas without their own message still answer in Spanish (a direct call never gets zod's English)", async () => {
    const S = z.object({ name: z.string().min(2), email: z.email(), tags: z.array(z.string()).min(1), n: z.number() })
    // A direct call can send anything: the wrong type for `n` on purpose.
    const r = await defineAction(S, { auth: "user" }, async () => 1)({ name: "x", email: "no", tags: [], n: "7" } as unknown as z.infer<typeof S>)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.fieldErrors).toEqual({
        name: ["Mínimo 2 caracteres"], email: ["Correo electrónico no válido"], tags: ["Elige al menos uno"], n: ["Valor no válido"],
      })
    }
    // Schema-level messages still win.
    const M = z.object({ key: z.string().regex(/^[A-Z]+$/, "Solo mayúsculas") })
    const m = await defineAction(M, { auth: "user" }, async () => 1)({ key: "a" })
    if (!m.ok) expect(m.error.fieldErrors).toEqual({ key: ["Solo mayúsculas"] })
  })
  it("NOT_HOLDER / RESERVED_BY_OTHER with auditDenied → the action audited as denied", async () => {
    const act = defineAction(Input, { auth: "user", auditDenied: "relay.set" }, async () => {
      throw new DomainError("RESERVED_BY_OTHER", "Reservado por Luis", undefined, { holderName: "Luis" })
    })
    const r = await act({ name: "ok", rows: [] })
    expect(r).toEqual({ ok: false, error: { code: "RESERVED_BY_OTHER", message: "Reservado por Luis", details: { holderName: "Luis" } } })
    expect(audit.inputs[0]).toMatchObject({ action: "relay.set", outcome: "denied", detail: { code: "RESERVED_BY_OTHER" } })
    const noAudit = await defineAction(Input, { auth: "user" }, async () => { throw new DomainError("NOT_HOLDER", "x") })({ name: "ok", rows: [] })
    expect(noAudit.ok).toBe(false)
    expect(audit.inputs).toHaveLength(1)
  })
  it("maps Prisma P2002 → CONFLICT (field from meta.target) and P2025 → NOT_FOUND", async () => {
    const p2002 = Object.assign(new Error("Unique constraint failed"), { code: "P2002", meta: { target: ["name"] } })
    const r1 = await defineAction(Input, { auth: "user" }, async () => { throw p2002 })({ name: "ok", rows: [] })
    expect(r1).toMatchObject({ ok: false, error: { code: "CONFLICT", fieldErrors: { name: [expect.any(String)] } } })
    const p2025 = Object.assign(new Error("not found"), { code: "P2025" })
    const r2 = await defineAction(Input, { auth: "user" }, async () => { throw p2025 })({ name: "ok", rows: [] })
    expect(r2).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } })
  })
  it("anything else → INTERNAL with a ref", async () => {
    const r = await defineAction(Input, { auth: "user" }, async () => { throw new Error("secret detail") })({ name: "ok", rows: [] })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe("INTERNAL")
      expect(r.error.message).toMatch(/^Error interno \(ref [0-9a-f]{8}\)$/)
      expect(r.error.message).not.toContain("secret")
    }
  })
  it("recognises DomainError structurally (other module graph)", async () => {
    const foreign = { name: "DomainError", code: "NOT_FOUND", message: "No existe" }
    const r = await defineAction(Input, { auth: "user" }, async () => { throw foreign })({ name: "ok", rows: [] })
    expect(r).toMatchObject({ ok: false, error: { code: "NOT_FOUND", message: "No existe" } })
  })
})

describe("definePublicAction", () => {
  it("validates and runs without a session", async () => {
    state.user = null
    const act = definePublicAction(Input, async (input, ctx) => ({ n: input.name, ip: ctx.ip }))
    expect(await act({ name: "ok", rows: [] })).toEqual({ ok: true, data: { n: "ok", ip: "10.9.9.9" } })
    expect(await act({ name: "x", rows: [] })).toMatchObject({ ok: false, error: { code: "VALIDATION" } })
  })
})
