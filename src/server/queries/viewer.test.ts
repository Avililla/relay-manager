import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { setRuntime } from "@/server/runtime/registry"
import type { AuthUser, Runtime } from "@/server/runtime/types"
import { createTestDb, fakeRuntime, makeUser, type TestDb } from "../../../test/helpers"
import { getShellData } from "./shell"
import { getViewer, getViewerTheme } from "./viewer"

const state = vi.hoisted(() => ({ user: null as AuthUser | null, throws: false }))
vi.mock("@/server/authz", () => ({
  getAuthUser: async () => {
    if (state.throws) throw new Error("boom")
    return state.user
  },
}))
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw new Error(`redirect:${to}`) } }))

const KEY = Symbol.for("relay-manager.runtime")
let db: TestDb
let rt: Runtime
let uid: string
beforeAll(async () => { db = await createTestDb() })
afterAll(async () => { await db.cleanup() })
beforeEach(async () => {
  const u = await makeUser(db.prisma)
  uid = u.id
  state.user = { id: u.id, username: u.username, name: u.name, isAdmin: false, roleIds: [], mustChangePassword: false, sessionVersion: 1 }
  state.throws = false
  rt = fakeRuntime({ prisma: db.prisma })
  setRuntime(rt)
})

describe("viewer DTO with the account theme", () => {
  it("getViewer: null until the user picks one, then the stored theme", async () => {
    expect((await getViewer()).theme).toBeNull()
    await db.prisma.user.update({ where: { id: uid }, data: { theme: "rosa" } })
    expect(await getViewer()).toMatchObject({ id: uid, theme: "rosa" })
  })
  it("getShellData: the shell's viewer carries the theme", async () => {
    await db.prisma.user.update({ where: { id: uid }, data: { theme: "system" } })
    const shell = await getShellData(state.user as AuthUser)
    expect(shell.viewer).toEqual({ id: uid, username: state.user?.username, name: state.user?.name, isAdmin: false, mustChangePassword: false, theme: "system" })
  })
  it("an unknown value in the database reads as no theme", async () => {
    await db.prisma.user.update({ where: { id: uid }, data: { theme: "sepia" } })
    expect((await getViewer()).theme).toBeNull()
  })
})

describe("getViewerTheme (root layout)", () => {
  it("signed out → null (the page uses the browser's cached theme)", async () => {
    state.user = null
    expect(await getViewerTheme()).toBeNull()
  })
  it("signed in → the account's theme, or null inside when none was chosen", async () => {
    expect(await getViewerTheme()).toEqual({ theme: null })
    await db.prisma.user.update({ where: { id: uid }, data: { theme: "rosa" } })
    expect(await getViewerTheme()).toEqual({ theme: "rosa" })
  })
  it("never throws: no runtime (next build) or a failing session read → null", async () => {
    state.throws = true
    expect(await getViewerTheme()).toBeNull()
    state.throws = false
    delete (globalThis as { [KEY]?: Runtime })[KEY]
    expect(await getViewerTheme()).toBeNull()
  })
})
