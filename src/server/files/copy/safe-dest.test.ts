import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { CopyError, listFolders, mkdirIn, openDestDir, writeIntoDir, type DestDir } from "./safe-dest"

const sha = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex")
async function* chunks(b: Buffer, size = 7) {
  for (let i = 0; i < b.length; i += size) yield b.subarray(i, i + size)
}
const tempsIn = (d: string) => fs.readdirSync(d).filter((n) => n.startsWith(".rm-copy-"))

describe("destination folder: opened without following links", () => {
  let root: string
  let real: string
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "rm-dest-"))
    real = fs.realpathSync(root)
    fs.mkdirSync(path.join(real, "usb", "fotos"), { recursive: true })
    fs.mkdirSync(path.join(real, "secreto"))
    fs.symlinkSync(path.join(real, "secreto"), path.join(real, "usb", "enlace"))
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  it("opens a real path and reports its owner", async () => {
    const d = await openDestDir(path.join(real, "usb", "fotos"))
    expect(d.real).toBe(path.join(real, "usb", "fotos"))
    expect(d.uid).toBe(process.getuid?.())
    await d.close()
  })

  it("refuses a link in any component (realpath first, then a component swapped for a link)", async () => {
    await expect(openDestDir(path.join(real, "usb", "enlace"))).rejects.toMatchObject({ code: "DENIED" })
    // The real path was "usb/fotos"; "usb" is replaced by a link to "secreto" before it is opened.
    const target = path.join(real, "usb", "fotos")
    fs.renameSync(path.join(real, "usb"), path.join(real, "usb-old"))
    fs.mkdirSync(path.join(real, "secreto", "fotos"))
    fs.symlinkSync(path.join(real, "secreto"), path.join(real, "usb"))
    await expect(openDestDir(target)).rejects.toBeInstanceOf(CopyError)
    await expect(openDestDir(target)).rejects.toMatchObject({ code: "DENIED" })
  })

  it("a missing folder is NOT_FOUND; a file is not a folder", async () => {
    await expect(openDestDir(path.join(real, "nada"))).rejects.toMatchObject({ code: "NOT_FOUND" })
    fs.writeFileSync(path.join(real, "f"), "x")
    await expect(openDestDir(path.join(real, "f"))).rejects.toMatchObject({ code: "DENIED" })
  })

  it("lists folders (links to folders marked, hidden on demand), never files", async () => {
    fs.mkdirSync(path.join(real, "usb", ".oculta"))
    fs.writeFileSync(path.join(real, "usb", "a.txt"), "x")
    const d = await openDestDir(path.join(real, "usb"))
    try {
      expect((await listFolders(d, false)).folders).toEqual([{ name: "enlace", hidden: false, link: true }, { name: "fotos", hidden: false, link: false }])
      expect((await listFolders(d, true)).folders.map((f) => f.name)).toEqual([".oculta", "enlace", "fotos"])
      expect(await listFolders(d, true, 1)).toMatchObject({ truncated: true })
    } finally {
      await d.close()
    }
  })
})

describe("writeIntoDir: temporary file, verification, conflicts", () => {
  let root: string
  let dir: DestDir
  const data = crypto.randomBytes(100_003)
  beforeEach(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rm-write-")))
    dir = await openDestDir(root)
  })
  afterEach(async () => {
    await dir.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  const write = (name: string, conflict: "replace" | "keep" | "skip", body = data, extra: Partial<Parameters<typeof writeIntoDir>[3]> = {}) =>
    writeIntoDir(dir, name, conflict, { size: body.length, source: chunks(body, 4096), mode: 0o644, owner: null, ...extra })

  it("writes, verifies (sha256), sets 0644 and leaves no temporary file", async () => {
    const progress: number[] = []
    let verifying = false
    const r = await write("imagen.bin", "keep", data, { onProgress: (n) => progress.push(n), onVerifying: () => { verifying = true } })
    expect(r).toEqual({ name: "imagen.bin", skipped: false, replaced: false, sha256: sha(data) })
    expect(sha(fs.readFileSync(path.join(root, "imagen.bin")))).toBe(sha(data))
    expect(fs.statSync(path.join(root, "imagen.bin")).mode & 0o777).toBe(0o644)
    expect(progress.at(-1)).toBe(data.length)
    expect(verifying).toBe(true)
    expect(tempsIn(root)).toEqual([])
  })

  it("Reemplazar / Conservar ambos / Omitir", async () => {
    fs.writeFileSync(path.join(root, "a.txt"), "viejo")
    expect(await write("a.txt", "skip", Buffer.from("nuevo"))).toMatchObject({ skipped: true, name: null })
    expect(fs.readFileSync(path.join(root, "a.txt"), "utf8")).toBe("viejo")
    expect(await write("a.txt", "keep", Buffer.from("nuevo"))).toMatchObject({ name: "a (1).txt", replaced: false })
    expect(await write("a.txt", "keep", Buffer.from("otro"))).toMatchObject({ name: "a (2).txt" })
    expect(await write("a.txt", "replace", Buffer.from("nuevo"))).toMatchObject({ name: "a.txt", replaced: true })
    expect(fs.readFileSync(path.join(root, "a.txt"), "utf8")).toBe("nuevo")
    expect(tempsIn(root)).toEqual([])
  })

  it("never replaces a folder; a link in the destination is replaced as a link, not followed", async () => {
    fs.mkdirSync(path.join(root, "carpeta"))
    await expect(write("carpeta", "replace")).rejects.toMatchObject({ code: "EXISTS" })
    expect(await write("carpeta", "keep")).toMatchObject({ name: "carpeta (1)" })
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rm-out-")))
    try {
      fs.writeFileSync(path.join(outside, "victima"), "intacto")
      fs.symlinkSync(path.join(outside, "victima"), path.join(root, "enlace"))
      expect(await write("enlace", "replace", Buffer.from("x"))).toMatchObject({ replaced: true })
      expect(fs.readFileSync(path.join(outside, "victima"), "utf8")).toBe("intacto")
      expect(fs.lstatSync(path.join(root, "enlace")).isFile()).toBe(true)
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it("refuses bad names before writing", async () => {
    for (const n of ["", "..", "a/b", ".rm-copy-x.part", " espacio", "a\nb"]) {
      await expect(write(n, "keep"), n).rejects.toMatchObject({ code: "INVALID" })
    }
    expect(tempsIn(root)).toEqual([])
  })

  it("a short or long source, a cancellation or a disk without room leave nothing behind", async () => {
    await expect(writeIntoDir(dir, "corto", "keep", { size: data.length + 10, source: chunks(data), mode: 0o644, owner: null })).rejects.toMatchObject({ code: "CANCELED" })
    await expect(writeIntoDir(dir, "largo", "keep", { size: 10, source: chunks(data), mode: 0o644, owner: null })).rejects.toMatchObject({ code: "IO" })
    const ac = new AbortController()
    await expect(write("cancelado", "keep", data, { signal: ac.signal, onProgress: (n) => { if (n > 50_000) ac.abort() } })).rejects.toMatchObject({ code: "CANCELED" })
    await expect(writeIntoDir(dir, "enorme", "keep", { size: 2 ** 52, source: chunks(Buffer.alloc(0)), mode: 0o644, owner: null })).rejects.toMatchObject({ code: "NO_SPACE" })
    expect(fs.readdirSync(root)).toEqual([])
  })

  it("the owner is set when asked (same uid here: the root helper passes the folder's)", async () => {
    const uid = process.getuid?.() ?? 0
    const gid = process.getgid?.() ?? 0
    await write("propio", "keep", Buffer.from("x"), { owner: { uid, gid } })
    expect(fs.statSync(path.join(root, "propio")).uid).toBe(uid)
  })

  it("mkdirIn: 0755, refuses existing and bad names", async () => {
    expect(await mkdirIn(dir, "nueva", null)).toBe(path.join(root, "nueva"))
    expect(fs.statSync(path.join(root, "nueva")).mode & 0o777).toBe(0o755)
    await expect(mkdirIn(dir, "nueva", null)).rejects.toMatchObject({ code: "EXISTS" })
    await expect(mkdirIn(dir, "../x", null)).rejects.toMatchObject({ code: "INVALID" })
  })
})
