import { describe, expect, it } from "vitest"
import { proxyDecision, type ProxyInput } from "./proxy-rules"

const base: ProxyInput = { pathname: "/", search: "", method: "GET", setupPending: false, user: null }
const user = { id: "u1", mustChangePassword: false }

describe("proxy rules (§6.5)", () => {
  it("1. /api/auth/* always passes", () => {
    expect(proxyDecision({ ...base, pathname: "/api/auth/csrf", setupPending: true })).toEqual({ kind: "next" })
  })
  it("2. setup pending: /setup passes, pages go to /setup, /api needs auth", () => {
    expect(proxyDecision({ ...base, pathname: "/setup", setupPending: true })).toEqual({ kind: "next" })
    expect(proxyDecision({ ...base, pathname: "/login", setupPending: true })).toEqual({ kind: "redirect", to: "/setup" })
    expect(proxyDecision({ ...base, pathname: "/", setupPending: true, user })).toEqual({ kind: "redirect", to: "/setup" })
    expect(proxyDecision({ ...base, pathname: "/api/events", setupPending: true })).toEqual({ kind: "unauthenticated" })
  })
  it("3. /setup when not pending → /login; a server-action POST passes so completeSetup answers SETUP_DONE", () => {
    expect(proxyDecision({ ...base, pathname: "/setup" })).toEqual({ kind: "redirect", to: "/login" })
    expect(proxyDecision({ ...base, pathname: "/setup", method: "HEAD" })).toEqual({ kind: "redirect", to: "/login" })
    expect(proxyDecision({ ...base, pathname: "/setup", method: "POST" })).toEqual({ kind: "next" })
  })
  it("4. no session: /login passes, /api → 401, pages → /login?next=", () => {
    expect(proxyDecision({ ...base, pathname: "/login" })).toEqual({ kind: "next" })
    expect(proxyDecision({ ...base, pathname: "/api/audit" })).toEqual({ kind: "unauthenticated" })
    expect(proxyDecision({ ...base, pathname: "/equipos/abc", search: "?tab=x" })).toEqual({ kind: "redirect", to: "/login?next=%2Fequipos%2Fabc%3Ftab%3Dx" })
    expect(proxyDecision({ ...base, pathname: "/" })).toEqual({ kind: "redirect", to: "/login" })
  })
  it("5. session: /login → /, mustChangePassword GET pages → /cuenta?cambiar=1", () => {
    expect(proxyDecision({ ...base, pathname: "/login", user })).toEqual({ kind: "redirect", to: "/" })
    const must = { id: "u1", mustChangePassword: true }
    expect(proxyDecision({ ...base, pathname: "/equipos/abc", user: must })).toEqual({ kind: "redirect", to: "/cuenta?cambiar=1" })
    expect(proxyDecision({ ...base, pathname: "/cuenta", user: must })).toEqual({ kind: "next" })
    expect(proxyDecision({ ...base, pathname: "/equipos/abc", method: "POST", user: must })).toEqual({ kind: "next" })
    expect(proxyDecision({ ...base, pathname: "/api/events", user: must })).toEqual({ kind: "next" })
  })
  it("6. otherwise next", () => {
    expect(proxyDecision({ ...base, pathname: "/equipos/abc", user })).toEqual({ kind: "next" })
  })
})
