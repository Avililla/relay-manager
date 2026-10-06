import { spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { acquireInstanceLock, InstanceLockedError, isInstanceRunning } from "./instance-lock"
import { withTempDir } from "../../../test/helpers"

const cleanups: Array<() => void> = []
const children: ChildProcess[] = []
afterEach(() => {
  for (const c of children.splice(0)) if (c.exitCode === null) c.kill("SIGKILL")
  for (const c of cleanups.splice(0)) c()
})
function tmp() { const t = withTempDir("rm-lock-"); cleanups.push(t.cleanup); return t.dir }

/** Holds the lock in a child process until killed. */
function holdInChild(dataDir: string): Promise<ChildProcess> {
  const script = path.join(dataDir, "..", `hold-${path.basename(dataDir)}.ts`)
  fs.writeFileSync(script, `import { acquireInstanceLock } from ${JSON.stringify(path.resolve(__dirname, "instance-lock.ts"))}
acquireInstanceLock(process.argv[2])
process.stdout.write("locked\\n")
setInterval(() => {}, 1000)
`)
  cleanups.push(() => fs.rmSync(script, { force: true }))
  const child = spawn(process.execPath, ["--import", "tsx", script, dataDir], { stdio: ["ignore", "pipe", "pipe"], cwd: path.resolve(__dirname, "../../..") })
  children.push(child)
  return new Promise((resolve, reject) => {
    let err = ""
    child.stderr?.on("data", (c: Buffer) => { err += c.toString() })
    child.stdout?.on("data", (c: Buffer) => { if (c.toString().includes("locked")) resolve(child) })
    child.on("exit", (code) => reject(new Error(`child exited ${code}: ${err}`)))
  })
}

describe("instance lock", () => {
  it("a lock held by another process → InstanceLockedError; released when that process is killed", async () => {
    const dir = tmp()
    const child = await holdInChild(dir)
    expect(isInstanceRunning(dir)).toBe(true)
    let caught: unknown
    try { acquireInstanceLock(dir) } catch (e) { caught = e }
    expect(caught).toBeInstanceOf(InstanceLockedError)
    expect((caught as InstanceLockedError).dataDir).toBe(dir)
    const exited = new Promise((resolve) => child.on("exit", resolve))
    child.kill("SIGKILL")
    await exited
    expect(isInstanceRunning(dir)).toBe(false)
    const lock = acquireInstanceLock(dir)
    lock.release()
  }, 30_000)

  it("isInstanceRunning is true while held in-process and false after release", () => {
    const dir = tmp()
    const lock = acquireInstanceLock(dir)
    expect(fs.statSync(path.join(dir, ".instance-lock")).mode & 0o777).toBe(0o600)
    expect(isInstanceRunning(dir)).toBe(true)
    expect(() => acquireInstanceLock(dir)).toThrow(InstanceLockedError)
    lock.release()
    lock.release() // idempotent
    expect(isInstanceRunning(dir)).toBe(false)
  })

  it("a missing data dir or lock file → false, and nothing is created", () => {
    const dir = tmp()
    expect(isInstanceRunning(path.join(dir, "nope"))).toBe(false)
    expect(isInstanceRunning(dir)).toBe(false)
    expect(fs.readdirSync(dir)).toEqual([])
  })

  it("a server.pid with the PID of a live unrelated process does not block", () => {
    const dir = tmp()
    fs.writeFileSync(path.join(dir, "server.pid"), `${process.ppid}\n`)
    const lock = acquireInstanceLock(dir)
    lock.release()
  })
})
