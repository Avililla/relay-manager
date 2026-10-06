import fs from "node:fs"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { withTempDir } from "../../../test/helpers"

vi.mock("@/server/config/load", () => ({
  loadConfig: vi.fn(() => { throw new Error("version must never call loadConfig") }),
  applyConfigEnv: vi.fn(),
  ConfigError: class ConfigError extends Error {},
}))

const { versionLine } = await import("./version")
const { runCli } = await import("./index")
const { bufferIO } = await import("./io")

const cleanups: Array<() => void> = []
afterEach(() => { for (const c of cleanups.splice(0)) c() })

function bundle(buildinfo: string | null) {
  const t = withTempDir("rm-ver-")
  cleanups.push(t.cleanup)
  const app = path.join(t.dir, "app")
  fs.mkdirSync(app)
  fs.writeFileSync(path.join(app, "package.json"), JSON.stringify({ name: "relay-manager", version: "2.0.0" }))
  if (buildinfo !== null) fs.writeFileSync(path.join(t.dir, "BUILDINFO"), buildinfo)
  return { root: t.dir, app }
}

describe("version", () => {
  it("prints version, rev, build date and node from appDir/package.json and bundleRoot/BUILDINFO", () => {
    const b = bundle("version=2.0.0\nrev=abc1234\nnode=22.23.2\nbuilt=2026-09-23T10:00:00Z\n")
    const line = versionLine({ env: { RM_APP_DIR: b.app }, argv1: "/x/server.js", cwd: "/", nodeVersion: "22.23.2" })
    expect(line).toBe("relay-manager 2.0.0 (rev abc1234, 2026-09-23T10:00:00Z) node 22.23.2")
  })

  it("falls back to dirname(argv[1]) for the app dir, and to 'dev' without BUILDINFO", () => {
    const b = bundle(null)
    expect(versionLine({ env: {}, argv1: path.join(b.app, "server.js"), cwd: "/", nodeVersion: "22.23.2" }))
      .toBe("relay-manager 2.0.0 (rev dev) node 22.23.2")
  })

  it("in dev (RM_DEV=1) reads the repo package.json from cwd", () => {
    const repo = path.resolve(__dirname, "../../..")
    const { version } = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8")) as { version: string }
    expect(versionLine({ env: { RM_DEV: "1" }, argv1: "/x", cwd: repo, nodeVersion: "22.23.2" })).toBe(`relay-manager ${version} (rev dev) node 22.23.2`)
  })

  it("the command creates no file or directory and never calls loadConfig", async () => {
    const b = bundle("rev=abc1234\nbuilt=2026-09-23T10:00:00Z\n")
    const before = fs.readdirSync(b.root).sort()
    const io = bufferIO()
    const prev = process.env.RM_APP_DIR
    process.env.RM_APP_DIR = b.app
    process.env.RM_DATA_DIR = path.join(b.root, "data")
    try {
      expect(await runCli("version", [], { io })).toBe(0)
    } finally {
      if (prev === undefined) delete process.env.RM_APP_DIR
      else process.env.RM_APP_DIR = prev
      delete process.env.RM_DATA_DIR
    }
    expect(io.stdout).toContain("relay-manager 2.0.0 (rev abc1234, 2026-09-23T10:00:00Z) node ")
    expect(fs.readdirSync(b.root).sort()).toEqual(before)
    const { loadConfig } = await import("@/server/config/load")
    expect(loadConfig).not.toHaveBeenCalled()
  })
})
