import { describe, expect, it } from "vitest"
import type { FileEntryDTO } from "@/lib/contracts/files"
import { affectsFolder, archiveUrl, crumbs, downloadUrl, filterEntries, listUrl, pageUrl, sortEntries, totals } from "./view"

const f = (name: string, size: number, mtime: string): FileEntryDTO => ({ name, kind: "file", size, mtime, link: false })
const d = (name: string, mtime = "2026-01-01T00:00:00.000Z"): FileEntryDTO => ({ name, kind: "dir", size: null, mtime, link: false })

describe("view helpers", () => {
  it("builds URLs with every path encoded", () => {
    expect(pageUrl("")).toBe("/archivos")
    expect(pageUrl("a b/ñ")).toBe("/archivos?ruta=a%20b%2F%C3%B1")
    expect(downloadUrl("x/y&z.bin")).toBe("/api/files/download?path=x%2Fy%26z.bin")
    expect(archiveUrl("", ["a", "b c"], "zip")).toBe("/api/files/archive?format=zip&dir=&name=a&name=b%20c")
    expect(archiveUrl("x y", ["ñ"], "tar.gz")).toBe("/api/files/archive?format=tar.gz&dir=x%20y&name=%C3%B1")
  })

  it("names the root in every URL except for the default one (tftp)", () => {
    expect(pageUrl("", "tftp")).toBe("/archivos")
    expect(pageUrl("", "extra")).toBe("/archivos?raiz=extra")
    expect(pageUrl("a b", "extra")).toBe("/archivos?raiz=extra&ruta=a%20b")
    expect(listUrl("x", "extra")).toBe("/api/files/list?root=extra&path=x")
    expect(listUrl("x")).toBe("/api/files/list?path=x")
    expect(downloadUrl("y.zip", "extra")).toBe("/api/files/download?root=extra&path=y.zip")
    expect(archiveUrl("", ["a"], "zip", "extra")).toBe("/api/files/archive?root=extra&format=zip&dir=&name=a")
  })

  it("splits breadcrumbs", () => {
    expect(crumbs("")).toEqual([])
    expect(crumbs("a/b")).toEqual([{ name: "a", path: "a" }, { name: "b", path: "a/b" }])
  })

  it("sorts folders first, with natural name order", () => {
    const list = [f("img10.bin", 5, "2026-01-03T00:00:00.000Z"), d("zeta"), f("img2.bin", 50, "2026-01-01T00:00:00.000Z"), d("Alfa"), f("Árbol", 1, "2026-01-02T00:00:00.000Z")]
    expect(sortEntries(list, { key: "name", dir: "asc" }).map((e) => e.name)).toEqual(["Alfa", "zeta", "Árbol", "img2.bin", "img10.bin"])
    expect(sortEntries(list, { key: "name", dir: "desc" }).map((e) => e.name)).toEqual(["zeta", "Alfa", "img10.bin", "img2.bin", "Árbol"])
    expect(sortEntries(list, { key: "size", dir: "desc" }).map((e) => e.name)).toEqual(["Alfa", "zeta", "img2.bin", "img10.bin", "Árbol"])
    expect(sortEntries(list, { key: "mtime", dir: "asc" }).map((e) => e.name).slice(2)).toEqual(["img2.bin", "Árbol", "img10.bin"])
  })

  it("filters without case or accents", () => {
    expect(filterEntries([f("Árbol.txt", 1, ""), f("otro", 1, "")], "arbol").map((e) => e.name)).toEqual(["Árbol.txt"])
    expect(filterEntries([f("a", 1, "")], "  ").length).toBe(1)
  })

  it("decides which live changes need a refresh", () => {
    expect(affectsFolder({ dirs: ["sub"], change: "upload" }, "sub")).toBe(true)
    expect(affectsFolder({ dirs: ["otra"], change: "upload" }, "sub")).toBe(false)
    expect(affectsFolder({ dirs: [""], change: "upload" }, "sub")).toBe(false)
    expect(affectsFolder({ dirs: [""], change: "delete" }, "sub/deep")).toBe(true)
    expect(affectsFolder({ dirs: ["sub"], change: "move" }, "sub/deep")).toBe(true)
    expect(affectsFolder({ dirs: ["su"], change: "move" }, "sub/deep")).toBe(false)
  })

  it("only refreshes for changes of the root being shown", () => {
    expect(affectsFolder({ root: "extra", dirs: [""], change: "upload" }, "", "extra")).toBe(true)
    expect(affectsFolder({ root: "extra", dirs: [""], change: "upload" }, "", "tftp")).toBe(false)
    expect(affectsFolder({ root: "tftp", dirs: [""], change: "upload" }, "", "extra")).toBe(false)
    expect(affectsFolder({ dirs: [""], change: "upload" }, "")).toBe(true)
  })

  it("adds up files and folders", () => {
    expect(totals([d("a"), f("b", 10, ""), f("c", 5, ""), { name: "l", kind: "other", size: null, mtime: null, link: true }])).toEqual({ dirs: 1, files: 2, bytes: 15 })
  })
})
