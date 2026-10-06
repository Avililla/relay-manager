import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import zlib from "node:zlib"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { withTempDir } from "../../../test/helpers"
import type { ArchiveEntry } from "./archive"
import { paxRecord, tarStream } from "./tar"

let t: { dir: string; cleanup: () => void }
beforeEach(() => { t = withTempDir("rm-tar-") })
afterEach(() => t.cleanup())

const hasTar = spawnSync("tar", ["--version"]).status === 0
const MTIME = new Date("2026-09-23T10:20:30.000Z")
const file = (name: string, data: Buffer | null, mode = 0o644, size = data?.length ?? 0): ArchiveEntry => ({
  name, kind: "file", mtime: MTIME, mode,
  open: async () => (data ? { size, stream: Readable.from([data.subarray(0, Math.ceil(data.length / 2)), data.subarray(Math.ceil(data.length / 2))]) } : null),
})
const dir = (name: string, mode = 0o755): ArchiveEntry => ({ name, kind: "dir", mtime: MTIME, mode })

async function writeTgz(entries: ArchiveEntry[], opts: { paxSizeThreshold?: number } = {}): Promise<string> {
  const out = path.join(t.dir, "out.tar.gz")
  await pipeline(Readable.from(tarStream(entries, opts)), zlib.createGzip(), fs.createWriteStream(out))
  return out
}
function extract(archive: string): string {
  const to = path.join(t.dir, "x")
  fs.mkdirSync(to, { recursive: true })
  const r = spawnSync("tar", ["-xzpf", archive, "-C", to], { encoding: "utf8" })
  if (r.status !== 0) throw new Error(r.stderr)
  return to
}

describe("paxRecord", () => {
  it("counts its own length", () => {
    expect(paxRecord("path", "a")).toBe("9 path=a\n")
    const long = paxRecord("path", "x".repeat(95))
    expect(long.length).toBe(Number(long.split(" ")[0]))
  })
})

describe.skipIf(!hasTar)("tarStream (+ gzip)", () => {
  it("round-trips files, nested empty folders, UTF-8 and long names, modes and mtimes", async () => {
    const longDir = `carpeta-${"larga-".repeat(12)}fin`
    const longName = `${longDir}/${"ñ".repeat(60)}-fichero-con-nombre-muy-largo.bin`
    const data = Buffer.from(Array.from({ length: 70_000 }, (_, i) => (i * 7) & 0xff))
    const out = await writeTgz([
      dir("vacía"),
      dir("vacía/más vacía"),
      dir(longDir),
      file(longName, data),
      file("script.sh", Buffer.from("#!/bin/sh\necho hola\n"), 0o755),
      file("cero.bin", Buffer.alloc(0)),
      file("exacto-512.bin", Buffer.alloc(512, 1)),
    ])
    const x = extract(out)
    expect(fs.statSync(path.join(x, "vacía", "más vacía")).isDirectory()).toBe(true)
    expect(fs.readdirSync(path.join(x, "vacía", "más vacía"))).toEqual([])
    expect(fs.readFileSync(path.join(x, longName)).equals(data)).toBe(true)
    expect(fs.statSync(path.join(x, "script.sh")).mode & 0o777).toBe(0o755)
    expect(fs.statSync(path.join(x, "cero.bin")).size).toBe(0)
    expect(fs.readFileSync(path.join(x, "exacto-512.bin")).equals(Buffer.alloc(512, 1))).toBe(true)
    expect(Math.round(fs.statSync(path.join(x, "script.sh")).mtimeMs / 1000)).toBe(MTIME.getTime() / 1000)
    const list = spawnSync("tar", ["-tzf", out], { encoding: "utf8" }).stdout.trim().split("\n")
    expect(list).toContain(longName)
    expect(list.some((l) => l.startsWith("PaxHeaders"))).toBe(false) // pax headers are metadata, not members
  })

  it("moves big sizes to pax records (forced threshold) and skips unreadable files", async () => {
    const data = Buffer.from("tamaño en registro pax")
    const out = await writeTgz([file("grande.bin", data), file("ilegible.bin", null)], { paxSizeThreshold: 10 })
    const x = extract(out)
    expect(fs.readFileSync(path.join(x, "grande.bin")).equals(data)).toBe(true)
    expect(fs.existsSync(path.join(x, "ilegible.bin"))).toBe(false)
  })

  it("pads a file that shrank while it was read (the archive stays valid)", async () => {
    const out = await writeTgz([file("encogido.bin", Buffer.from("abc"), 0o644, 10), file("siguiente.txt", Buffer.from("ok"))])
    const x = extract(out)
    expect(fs.readFileSync(path.join(x, "encogido.bin"))).toEqual(Buffer.from("abc\0\0\0\0\0\0\0"))
    expect(fs.readFileSync(path.join(x, "siguiente.txt"), "utf8")).toBe("ok")
  })
})
