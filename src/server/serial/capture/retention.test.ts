import fs from "node:fs"
import path from "node:path"
import zlib from "node:zlib"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { withTempDir } from "../../../../test/helpers/temp"
import { diskGuard, listCaptureFiles, parseCaptureName, runRetention } from "./retention"

let tmp: { dir: string; cleanup: () => void }
beforeEach(() => { tmp = withTempDir("rm-ret-") })
afterEach(() => tmp.cleanup())

const NOW = new Date("2026-09-23T10:00:00.000Z")
const MiB = 1024 * 1024
const GiB = 1024 * MiB

function put(consoleId: string, name: string, bytes: number, mtime?: Date): string {
  const dir = path.join(tmp.dir, consoleId)
  fs.mkdirSync(dir, { recursive: true })
  const p = path.join(dir, name)
  fs.writeFileSync(p, Buffer.alloc(bytes, 0x61))
  if (mtime) fs.utimesSync(p, mtime, mtime)
  return p
}
const has = (consoleId: string, name: string) => fs.existsSync(path.join(tmp.dir, consoleId, name))

describe("parseCaptureName", () => {
  it("accepts the capture names only", () => {
    expect(parseCaptureName("2026-09-23.log")).toEqual({ date: "2026-09-23", index: 0, input: false, compressed: false })
    expect(parseCaptureName("2026-09-23.2.input.log.gz")).toEqual({ date: "2026-09-23", index: 2, input: true, compressed: true })
    expect(parseCaptureName("meta.json")).toBeNull()
    expect(parseCaptureName("../2026-09-23.log")).toBeNull()
  })
})

describe("runRetention", () => {
  it("compresses previous days (never today's or an active file) and keeps the content", async () => {
    const old = put("c1", "2026-09-22.log", 1000)
    fs.writeFileSync(old, "[2026-09-22T23:00:00.000Z] hola\n")
    put("c1", "2026-09-22.input.log", 10)
    put("c1", "2026-09-23.log", 10)
    const activeOld = put("c2", "2026-09-22.1.log", 10)   // still being written right after midnight
    const r = await runRetention({ captureDir: tmp.dir, retentionDays: 30, maxTotalBytes: 10 * GiB, activeFiles: new Set([activeOld]), now: NOW })
    expect(r.compressed).toBe(2)
    expect(has("c1", "2026-09-22.log")).toBe(false)
    expect(zlib.gunzipSync(fs.readFileSync(path.join(tmp.dir, "c1", "2026-09-22.log.gz"))).toString()).toBe("[2026-09-22T23:00:00.000Z] hola\n")
    expect(has("c1", "2026-09-22.input.log.gz")).toBe(true)
    expect(has("c1", "2026-09-23.log")).toBe(true)
    expect(has("c2", "2026-09-22.1.log")).toBe(true)
  })

  it("deletes files older than the retention days", async () => {
    put("c1", "2026-08-20.log.gz", 10)
    put("c1", "2026-08-24.log.gz", 10)
    put("c1", "2026-08-25.input.log.gz", 10)
    const r = await runRetention({ captureDir: tmp.dir, retentionDays: 30, maxTotalBytes: 10 * GiB, activeFiles: new Set(), now: NOW })
    expect(r.deletedByAge).toBe(2)
    expect(has("c1", "2026-08-20.log.gz")).toBe(false)
    expect(has("c1", "2026-08-24.log.gz")).toBe(false)
    expect(has("c1", "2026-08-25.input.log.gz")).toBe(true)
  })

  it("over the total cap it evicts from the largest console first, oldest file first, never an active file", async () => {
    // chatty console: 5 × 300 KiB; quiet console: its precious boot logs, 2 × 50 KiB
    const chatty = ["2026-09-19.log.gz", "2026-09-20.log.gz", "2026-09-21.log.gz", "2026-09-22.log.gz"].map((n) => put("chatty", n, 300 * 1024))
    const active = put("chatty", "2026-09-23.log", 300 * 1024)
    put("quiet", "2026-09-01.log.gz", 50 * 1024)
    put("quiet", "2026-09-23.log", 50 * 1024)
    const r = await runRetention({ captureDir: tmp.dir, retentionDays: 365, maxTotalBytes: 800 * 1024, activeFiles: new Set([active]), now: NOW })
    expect(r.deletedBySize).toBe(3)
    expect(fs.existsSync(chatty[0])).toBe(false)
    expect(fs.existsSync(chatty[1])).toBe(false)
    expect(fs.existsSync(chatty[2])).toBe(false)
    expect(fs.existsSync(chatty[3])).toBe(true)
    expect(fs.existsSync(active)).toBe(true)
    expect(has("quiet", "2026-09-01.log.gz")).toBe(true)
    expect(r.totalBytes).toBeLessThanOrEqual(800 * 1024)
  })

  it("when the largest console only has active files, it moves on to the next one", async () => {
    const a = put("big", "2026-09-23.log", 900 * 1024)
    put("small", "2026-09-20.log.gz", 100 * 1024)
    put("small", "2026-09-21.log.gz", 100 * 1024)
    const r = await runRetention({ captureDir: tmp.dir, retentionDays: 365, maxTotalBytes: 1000 * 1024, activeFiles: new Set([a]), now: NOW })
    expect(fs.existsSync(a)).toBe(true)
    expect(has("small", "2026-09-20.log.gz")).toBe(false)
    expect(has("small", "2026-09-21.log.gz")).toBe(true)
    expect(r.deletedBySize).toBe(1)
  })

  it("ignores foreign directories and files", async () => {
    fs.mkdirSync(path.join(tmp.dir, "..weird"), { recursive: true })
    put("c1", "notes.txt", 10)
    const r = await runRetention({ captureDir: tmp.dir, retentionDays: 1, maxTotalBytes: 1, activeFiles: new Set(), now: NOW })
    expect(has("c1", "notes.txt")).toBe(true)
    expect(r.deletedByAge + r.deletedBySize).toBe(0)
  })
})

describe("listCaptureFiles", () => {
  it("newest first; .input.log only when asked (admins)", async () => {
    put("c1", "2026-09-21.log.gz", 5)
    put("c1", "2026-09-23.log", 5)
    put("c1", "2026-09-23.1.log", 5)
    put("c1", "2026-09-23.1.input.log", 5)
    put("c1", "meta.json", 5)
    const users = await listCaptureFiles(path.join(tmp.dir, "c1"), false)
    expect(users.map((f) => f.name)).toEqual(["2026-09-23.1.log", "2026-09-23.log", "2026-09-21.log.gz"])
    expect(users[2]).toMatchObject({ date: "2026-09-21", compressed: true, input: false, sizeBytes: 5 })
    const admins = await listCaptureFiles(path.join(tmp.dir, "c1"), true)
    expect(admins.map((f) => f.name)).toContain("2026-09-23.1.input.log")
    expect(admins.find((f) => f.name === "2026-09-23.1.input.log")?.input).toBe(true)
    expect(await listCaptureFiles(path.join(tmp.dir, "missing"), true)).toEqual([])
  })
})

describe("diskGuard (hysteresis)", () => {
  const fsOf = (freeBytes: number, sizeBytes: number) => ({ bsize: 4096, bavail: Math.floor(freeBytes / 4096), blocks: Math.floor(sizeBytes / 4096) })

  it("pauses below max(512 MiB, 2 %) and resumes only above pauseBelow + 1 GiB", () => {
    const size = 10 * GiB
    expect(diskGuard(false, fsOf(600 * MiB, size)).paused).toBe(false)
    const low = diskGuard(false, fsOf(500 * MiB, size))
    expect(low.paused).toBe(true)
    expect(low.pauseBelow).toBe(512 * MiB)
    expect(low.resumeAbove).toBe(512 * MiB + GiB)
    expect(diskGuard(true, fsOf(600 * MiB, size)).paused).toBe(true)        // no flapping
    expect(diskGuard(true, fsOf(1.4 * GiB, size)).paused).toBe(true)
    expect(diskGuard(true, fsOf(1.6 * GiB, size)).paused).toBe(false)
  })

  it("2 % wins on large filesystems", () => {
    const size = 1000 * GiB
    const r = diskGuard(false, fsOf(19 * GiB, size))
    expect(r.pauseBelow).toBeCloseTo(20 * GiB, -6)
    expect(r.paused).toBe(true)
    expect(diskGuard(true, fsOf(20.5 * GiB, size)).paused).toBe(true)
    expect(diskGuard(true, fsOf(21.1 * GiB, size)).paused).toBe(false)
  })
})
