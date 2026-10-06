// Races with someone who can write in the folder (its owner, over SSH): a subfolder swapped for a symbolic link to the
// data dir between the check of a path and the operation on it must never make the operation reach the data dir.
// Every operation acts through an open descriptor of its folder (/proc/self/fd/<n>/<name>), so the swap only
// changes names, never where the operation lands.
import fs from "node:fs"
import path from "node:path"
import { Readable } from "node:stream"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createNullLogger } from "@/server/log"
import { fakeAudit, fakeBus, withTempDir } from "../../../test/helpers"
import { createFilesCore } from "./core"

const hasProc = fs.existsSync("/proc/self/fd")
const actor = { kind: "user" as const, id: "u1", name: "ana", ip: null }
const uploader = { id: "u1", name: "Ana", username: "ana", ip: null, isAdmin: false }

let t: { dir: string; cleanup: () => void }
let root: string
let data: string

beforeEach(() => {
  t = withTempDir("rm-files-race-")
  root = path.join(t.dir, "tftp")
  data = path.join(t.dir, "data")
  fs.mkdirSync(path.join(root, "sub", "deep"), { recursive: true })
  fs.mkdirSync(data)
  fs.writeFileSync(path.join(data, "relay-manager.db"), "DB")
  fs.writeFileSync(path.join(data, "keep.txt"), "keep")
  fs.writeFileSync(path.join(root, "sub", "relay-manager.db"), "decoy")
  fs.writeFileSync(path.join(root, "sub", "deep", "x"), "x")
})
afterEach(() => {
  vi.restoreAllMocks()
  t.cleanup()
})

const core = () => createFilesCore({
  config: {
    files: { enabled: true, dir: root, maxUploadBytes: 1e9, deleteAdminOnly: false, extraEnabled: false, extraDir: "/nonexistent-extra", extraName: "Compartida", extraHint: "Segunda carpeta compartida" },
    dataDir: data, backupDir: path.join(data, "backups"), captureDir: path.join(data, "consoles"),
    dbFile: path.join(data, "relay-manager.db"), appDir: path.join(t.dir, "app"),
  },
  log: createNullLogger(), bus: fakeBus(), audit: fakeAudit(),
}, { reserveBytes: 0 })

/** The attacker's move: `<root>/<dir>` becomes `<dir>2`, and `<dir>` a link to the data dir. */
function swap(dir: string): void {
  fs.renameSync(path.join(root, dir), path.join(root, `${dir}2`))
  fs.symlinkSync(data, path.join(root, dir))
}

/** Runs `swap(dir)` right after the first call of fs.promises[method] whose path matches. */
function swapAfter(method: "lstat" | "realpath", match: (p: string) => boolean, dir: string): void {
  const real = fs.promises[method].bind(fs.promises) as (p: fs.PathLike, ...a: unknown[]) => Promise<unknown>
  let done = false
  vi.spyOn(fs.promises, method).mockImplementation((async (p: fs.PathLike, ...a: unknown[]) => {
    const r = await real(p, ...a).catch((e: unknown) => ({ __error: e }))
    if (!done && match(String(p))) {
      done = true
      swap(dir)
    }
    if (r && typeof r === "object" && "__error" in r) throw (r as { __error: unknown }).__error
    return r
  }) as never)
}

const dataIntact = () => {
  expect(fs.readFileSync(path.join(data, "relay-manager.db"), "utf8")).toBe("DB")
  expect(fs.readdirSync(data).sort()).toEqual(["keep.txt", "relay-manager.db"])
}

describe.skipIf(!hasProc)("folder swapped for a link during an operation", () => {
  it("delete of a file: deletes the decoy in the original folder, never the database", async () => {
    swapAfter("lstat", (p) => p.endsWith("/relay-manager.db"), "sub")
    await core().remove(["sub/relay-manager.db"], actor, "ana")
    dataIntact()
    expect(fs.existsSync(path.join(root, "sub2", "relay-manager.db"))).toBe(false)
  })

  it("recursive delete: a subfolder swapped mid-way stops the deletion", async () => {
    fs.renameSync(path.join(root, "sub", "deep"), path.join(root, "deep"))
    fs.mkdirSync(path.join(root, "tree", "a"), { recursive: true })
    fs.writeFileSync(path.join(root, "tree", "a", "f"), "f")
    swapAfter("lstat", (p) => p.endsWith("/a"), "tree/a")
    await core().remove(["tree"], actor, "ana").catch(() => undefined)
    dataIntact()
    expect(fs.lstatSync(path.join(root, "tree", "a")).isSymbolicLink()).toBe(true) // the swap happened
  })

  it("move: the file goes to the folder that was checked, never into the data dir", async () => {
    fs.mkdirSync(path.join(root, "dst"))
    fs.writeFileSync(path.join(root, "auth-secret"), "attacker-chosen")
    swapAfter("lstat", (p) => p.endsWith("/auth-secret"), "dst")
    await core().move(["auth-secret"], "dst", actor, "ana").catch(() => undefined)
    dataIntact()
    expect(fs.existsSync(path.join(root, "dst2"))).toBe(true) // the swap happened
  })

  it("rename: acts in the original folder", async () => {
    swapAfter("lstat", (p) => p.endsWith("/relay-manager.db"), "sub")
    await core().rename("sub/relay-manager.db", "otro.db", actor, "ana").catch(() => undefined)
    dataIntact()
    expect(fs.readFileSync(path.join(root, "sub2", "otro.db"), "utf8")).toBe("decoy")
  })

  it("new folder: a parent swapped after its check is refused", async () => {
    swapAfter("realpath", (p) => p.endsWith("/sub"), "sub")
    await core().mkdir("sub", "nueva", actor, "ana").catch(() => undefined)
    dataIntact()
    expect(fs.existsSync(path.join(root, "sub2"))).toBe(true) // the swap happened
  })

  it("upload: the commit lands in the folder chosen at the start, whatever its path becomes", async () => {
    const c = core()
    const s = await c.uploadStart({ dir: "sub", name: "subido.bin", size: 3, conflict: "overwrite" }, uploader)
    swap("sub")
    const r = await c.uploadChunk(s.id, "u1", 0, Readable.from([Buffer.from("abc")]))
    expect(r.done).toBe(true)
    dataIntact()
    expect(fs.readFileSync(path.join(root, "sub2", "subido.bin"), "utf8")).toBe("abc")
    await c.stop()
  })

  it("archive walk: a subfolder swapped for a link is not read", async () => {
    swapAfter("lstat", (p) => p.endsWith("/deep"), "sub/deep")
    const src = await core().archiveSource("", ["sub"])
    const names: string[] = []
    for await (const e of src.entries) {
      names.push(e.name)
      const b = await e.open?.()
      if (b) {
        for await (const chunk of b.stream) expect(Buffer.from(chunk).toString()).not.toBe("DB")
        b.close?.()
      }
    }
    expect(names.some((n) => n.includes("relay-manager.db") && n.startsWith("sub/deep"))).toBe(false)
    expect(fs.existsSync(path.join(root, "sub", "deep2"))).toBe(true) // the swap happened
  })
})
