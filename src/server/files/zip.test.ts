import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { withTempDir } from "../../../test/helpers"
import type { ArchiveEntry } from "./archive"
import { zipStream } from "./zip"

let t: { dir: string; cleanup: () => void }
beforeEach(() => { t = withTempDir("rm-zip-") })
afterEach(() => t.cleanup())

async function write(entries: ArchiveEntry[], opts: { forceZip64?: boolean } = {}): Promise<string> {
  const file = path.join(t.dir, "out.zip")
  const parts: Buffer[] = []
  for await (const b of zipStream(entries, opts)) parts.push(b)
  fs.writeFileSync(file, Buffer.concat(parts))
  return file
}

const bytes = (n: number, seed = 1) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 31 + seed) & 0xff))
const fileEntry = (name: string, data: Buffer | null, size = data?.length ?? 0): ArchiveEntry => ({
  name, kind: "file", mtime: new Date(2026, 8, 23, 10, 20, 30), mode: 0o644,
  open: async () => (data ? { size, stream: (async function* () { for (let i = 0; i < data.length; i += 7000) yield data.subarray(i, i + 7000) })() } : null),
})

/** Python's zipfile: CRC check of every member and the listing. */
function pyCheck(file: string): { names: string[]; sizes: number[]; bad: string | null; digest: string } {
  const code = `
import sys, zipfile, json, hashlib
z = zipfile.ZipFile(sys.argv[1])
bad = z.testzip()
h = hashlib.sha256()
for i in z.infolist():
    if not i.is_dir(): h.update(z.read(i))
print(json.dumps({"names": z.namelist(), "sizes": [i.file_size for i in z.infolist()], "bad": bad, "digest": h.hexdigest()}))`
  const r = spawnSync("python3", ["-c", code, file], { encoding: "utf8" })
  if (r.status !== 0) throw new Error(r.stderr)
  return JSON.parse(r.stdout) as { names: string[]; sizes: number[]; bad: string | null; digest: string }
}

const hasPython = spawnSync("python3", ["--version"]).status === 0
const hasUnzip = spawnSync("unzip", ["-v"]).status === 0

describe.skipIf(!hasPython)("zipStream", () => {
  it("writes a valid archive with folders, UTF-8 names and stored files", async () => {
    const a = bytes(100_000)
    const b = bytes(3, 7)
    const file = await write([
      { name: "imágenes", kind: "dir", mtime: new Date(), mode: 0o755 },
      fileEntry("imágenes/BOOT.BIN", a),
      fileEntry("vacío.txt", Buffer.alloc(0)),
      fileEntry("b.txt", b),
    ])
    const r = pyCheck(file)
    expect(r.bad).toBeNull()
    expect(r.names).toEqual(["imágenes/", "imágenes/BOOT.BIN", "vacío.txt", "b.txt"])
    expect(r.sizes).toEqual([0, 100_000, 0, 3])
    if (hasUnzip) {
      const u = spawnSync("unzip", ["-t", file], { encoding: "utf8" })
      expect(u.status, u.stdout + u.stderr).toBe(0)
    }
  })

  it("stores at most the size seen when the file was opened; an unreadable file is left out", async () => {
    const grown = bytes(5000)
    const file = await write([fileEntry("grew.bin", grown, 1000), fileEntry("gone.bin", null, 1234)])
    const r = pyCheck(file)
    expect(r.bad).toBeNull()
    expect(r.names).toEqual(["grew.bin"])
    expect(r.sizes).toEqual([1000])
  })

  it("writes ZIP64 records that readers accept", async () => {
    const a = bytes(70_000)
    const file = await write([fileEntry("a.bin", a), { name: "d", kind: "dir", mtime: new Date(), mode: 0o755 }, fileEntry("d/b.bin", bytes(10))], { forceZip64: true })
    const r = pyCheck(file)
    expect(r.bad).toBeNull()
    expect(r.sizes).toEqual([70_000, 0, 10])
    const raw = fs.readFileSync(file)
    expect(raw.includes(Buffer.from([0x50, 0x4b, 0x06, 0x06]))).toBe(true) // zip64 end of central directory
    if (hasUnzip) {
      const u = spawnSync("unzip", ["-t", file], { encoding: "utf8" })
      expect(u.status, u.stdout + u.stderr).toBe(0)
    }
  })
})

/**
 * Real ZIP64 (a 4.1 GiB sparse file, so the archive also passes 4 GiB): slow and needs ~4.5 GB of disk, so only with
 * RM_TEST_BIG=1. The forced-ZIP64 test above checks the same records on small data every run.
 */
describe.skipIf(!hasPython || process.env.RM_TEST_BIG !== "1")("zipStream over 4 GiB", () => {
  it("writes a file of 4.1 GiB (ZIP64 sizes) followed by one past the 4 GiB offset", { timeout: 600_000 }, async () => {
    const big = path.join(t.dir, "grande.img")
    const size = 4 * 1024 ** 3 + 100 * 1024 ** 2
    fs.closeSync(fs.openSync(big, "w"))
    fs.truncateSync(big, size)
    const fd = fs.openSync(big, "r+")
    fs.writeSync(fd, Buffer.from("fin"), 0, 3, size - 3)
    fs.closeSync(fd)
    const out = path.join(t.dir, "big.zip")
    const ws = fs.createWriteStream(out)
    const entries: ArchiveEntry[] = [
      { name: "grande.img", kind: "file", mtime: new Date(), mode: 0o644, open: async () => ({ size, stream: fs.createReadStream(big, { highWaterMark: 1024 * 1024 }) }) },
      fileEntry("despues.txt", Buffer.from("después de los 4 GiB")),
    ]
    const { pipeline } = await import("node:stream/promises")
    const { Readable } = await import("node:stream")
    await pipeline(Readable.from(zipStream(entries)), ws)
    fs.rmSync(big)
    const code = `
import sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
i = z.getinfo("grande.img")
assert i.file_size == int(sys.argv[2]), i.file_size
with z.open(i) as f:
    f.seek(i.file_size - 3); assert f.read() == b"fin"
assert z.read("despues.txt").decode() == "después de los 4 GiB"
assert z.getinfo("despues.txt").header_offset > 0xFFFFFFFF
print("ok")`
    const r = spawnSync("python3", ["-c", code, out, String(size)], { encoding: "utf8" })
    expect(r.stdout.trim(), r.stderr).toBe("ok")
    if (hasUnzip) {
      const u = spawnSync("unzip", ["-l", out], { encoding: "utf8" })
      expect(u.status, u.stderr).toBe(0)
      expect(u.stdout).toContain("despues.txt")
    }
  })
})
