import fs from "node:fs"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { isDomainError } from "@/server/errors"
import { withTempDir } from "../../../test/helpers"
import { assertFdInside, isWithin, openRoot, parseOrThrow, resolveExisting, resolveParent } from "./paths"

let t: { dir: string; cleanup: () => void }
let root: string
let outside: string

beforeEach(() => {
  t = withTempDir("rm-files-paths-")
  root = path.join(t.dir, "tftp")
  outside = path.join(t.dir, "secreto")
  fs.mkdirSync(path.join(root, "sub", "deep"), { recursive: true })
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(root, "a.txt"), "a")
  fs.writeFileSync(path.join(root, "sub", "b.txt"), "b")
  fs.writeFileSync(path.join(outside, "auth-secret"), "top secret")
  fs.symlinkSync(path.join(outside, "auth-secret"), path.join(root, "escape-file"))
  fs.symlinkSync(outside, path.join(root, "escape-dir"))
  fs.symlinkSync("../../secreto", path.join(root, "sub", "escape-rel"))
  fs.symlinkSync(path.join(root, "a.txt"), path.join(root, "inside-link"))
  fs.symlinkSync("sub", path.join(root, "inside-dir"))
  fs.symlinkSync(path.join(root, "nope"), path.join(root, "broken"))
})
afterEach(() => t.cleanup())

const kindOf = async (p: Promise<unknown>) => {
  try {
    await p
    return "ok"
  } catch (e) {
    return isDomainError(e) ? String(e.details?.files) : `throw ${String(e)}`
  }
}

describe("isWithin", () => {
  it("is a path-prefix check on separators, not on strings", () => {
    expect(isWithin("/a/b", "/a/b")).toBe(true)
    expect(isWithin("/a/b/c", "/a/b")).toBe(true)
    expect(isWithin("/a/bc", "/a/b")).toBe(false)
    expect(isWithin("/a", "/a/b")).toBe(false)
  })
})

describe("parseOrThrow", () => {
  it("turns bad relative paths into INVALID", async () => {
    for (const raw of ["..", "../x", "a/../../x", "/etc/passwd", "a\0b", "a//b"]) {
      expect(await kindOf(Promise.resolve().then(() => parseOrThrow(raw)))).toBe("INVALID")
    }
    expect(parseOrThrow("sub/b.txt").segments).toEqual(["sub", "b.txt"])
  })
})

describe("openRoot", () => {
  it("returns the real path of the folder (itself possibly a symlink)", async () => {
    const alias = path.join(t.dir, "alias")
    fs.symlinkSync(root, alias)
    expect(await openRoot(alias)).toBe(fs.realpathSync(root))
  })
  it("reports a missing folder or a file as UNAVAILABLE", async () => {
    expect(await kindOf(openRoot(path.join(t.dir, "missing")))).toBe("UNAVAILABLE")
    expect(await kindOf(openRoot(path.join(root, "a.txt")))).toBe("UNAVAILABLE")
  })
})

describe("resolveExisting", () => {
  it("resolves files, folders and links that stay inside", async () => {
    const r = await openRoot(root)
    expect((await resolveExisting(r, ["sub", "b.txt"])).real).toBe(path.join(r, "sub", "b.txt"))
    expect((await resolveExisting(r, [])).real).toBe(r)
    expect((await resolveExisting(r, ["inside-link"])).real).toBe(path.join(r, "a.txt"))
    expect((await resolveExisting(r, ["inside-dir", "b.txt"])).real).toBe(path.join(r, "sub", "b.txt"))
  })
  it("never leaves the folder through a symlink (absolute, relative or as a parent)", async () => {
    const r = await openRoot(root)
    expect(await kindOf(resolveExisting(r, ["escape-file"]))).toBe("NOT_FOUND")
    expect(await kindOf(resolveExisting(r, ["escape-dir"]))).toBe("NOT_FOUND")
    expect(await kindOf(resolveExisting(r, ["escape-dir", "auth-secret"]))).toBe("NOT_FOUND")
    expect(await kindOf(resolveExisting(r, ["sub", "escape-rel", "auth-secret"]))).toBe("NOT_FOUND")
    expect(await kindOf(resolveExisting(r, ["broken"]))).toBe("NOT_FOUND")
    expect(await kindOf(resolveExisting(r, ["nothing-here"]))).toBe("NOT_FOUND")
  })
})

describe("resolveParent", () => {
  it("gives the real parent and the entry path without following the entry itself", async () => {
    const r = await openRoot(root)
    expect(await resolveParent(r, ["sub", "new.bin"])).toEqual({ parentReal: path.join(r, "sub"), name: "new.bin", target: path.join(r, "sub", "new.bin") })
    // The link itself (deleting a link removes the link, not its target).
    expect((await resolveParent(r, ["escape-file"])).target).toBe(path.join(r, "escape-file"))
    expect((await resolveParent(r, ["inside-dir", "x"])).parentReal).toBe(path.join(r, "sub"))
  })
  it("refuses parents outside the folder, missing parents, files as parents and the root itself", async () => {
    const r = await openRoot(root)
    expect(await kindOf(resolveParent(r, ["escape-dir", "x"]))).toBe("NOT_FOUND")
    expect(await kindOf(resolveParent(r, ["sub", "escape-rel", "x"]))).toBe("NOT_FOUND")
    expect(await kindOf(resolveParent(r, ["missing", "x"]))).toBe("NOT_FOUND")
    expect(await kindOf(resolveParent(r, ["a.txt", "x"]))).toBe("NOT_FOUND")
    expect(await kindOf(resolveParent(r, []))).toBe("INVALID")
  })
})

describe("assertFdInside", () => {
  it("accepts descriptors of files inside and refuses the others (TOCTOU guard)", async () => {
    const r = await openRoot(root)
    const inside = await fs.promises.open(path.join(r, "a.txt"), "r")
    const out = await fs.promises.open(path.join(outside, "auth-secret"), "r")
    try {
      await expect(assertFdInside(inside.fd, r)).resolves.toBeUndefined()
      expect(await kindOf(assertFdInside(out.fd, r))).toBe("NOT_FOUND")
    } finally {
      await inside.close()
      await out.close()
    }
  })
})
