import { describe, expect, it } from "vitest"
import { checkRemotePath, remoteBasename, remoteDirname, remoteJoin, remoteNameProblem, resolveRemotePath } from "./remote-path"

const resolve = (raw: string, home = "/root") => {
  const p = checkRemotePath(raw)
  if (!p.ok) throw new Error(p.error)
  return { path: resolveRemotePath(p, home), trailingSlash: p.trailingSlash }
}

describe("ruta de destino en el equipo", () => {
  it("~ y ~/… son la carpeta personal; lo relativo también; lo absoluto, tal cual", () => {
    expect(resolve("~")).toEqual({ path: "/root", trailingSlash: false })
    expect(resolve("~/")).toEqual({ path: "/root", trailingSlash: false })
    expect(resolve("~/imgs")).toEqual({ path: "/root/imgs", trailingSlash: false })
    expect(resolve("~/imgs/")).toEqual({ path: "/root/imgs", trailingSlash: true })
    expect(resolve("imgs/BOOT.BIN")).toEqual({ path: "/root/imgs/BOOT.BIN", trailingSlash: false })
    expect(resolve("/tmp")).toEqual({ path: "/tmp", trailingSlash: false })
    expect(resolve("/")).toEqual({ path: "/", trailingSlash: false })
    expect(resolve("/mnt/sd/")).toEqual({ path: "/mnt/sd", trailingSlash: true })
    expect(resolve("~/a", "/home/user/")).toEqual({ path: "/home/user/a", trailingSlash: false })
  })

  it("normaliza barras dobles y «.»; conserva «..» (lo resuelve el equipo) y los espacios interiores", () => {
    expect(resolve("//tmp//./x")).toEqual({ path: "/tmp/x", trailingSlash: false })
    expect(resolve("~/../etc")).toEqual({ path: "/root/../etc", trailingSlash: false })
    expect(resolve("  ~/con espacios  ")).toEqual({ path: "/root/con espacios", trailingSlash: false })
    expect(resolve("/tmp/it's $(x) `y`")).toEqual({ path: "/tmp/it's $(x) `y`", trailingSlash: false })
  })

  it("rechaza: vacía, ~otro, caracteres de control y demasiado larga", () => {
    expect(checkRemotePath("   ")).toMatchObject({ ok: false, error: expect.stringContaining("Escribe la ruta") })
    expect(checkRemotePath("~pepe/x")).toMatchObject({ ok: false, error: expect.stringContaining("~ o ~/carpeta") })
    expect(checkRemotePath("/tmp/a\nb")).toMatchObject({ ok: false, error: expect.stringContaining("saltos de línea") })
    expect(checkRemotePath("/tmp/a\u0000b")).toMatchObject({ ok: false })
    expect(checkRemotePath(`/${"a".repeat(1100)}`)).toMatchObject({ ok: false, error: expect.stringContaining("demasiado larga") })
  })

  it("join, dirname y basename POSIX", () => {
    expect(remoteJoin("/", "x")).toBe("/x")
    expect(remoteJoin("/a/", "")).toBe("/a")
    expect(remoteJoin("/", "")).toBe("/")
    expect(remoteDirname("/a/b")).toBe("/a")
    expect(remoteDirname("/a")).toBe("/")
    expect(remoteDirname("/")).toBe("/")
    expect(remoteBasename("/a/b.bin")).toBe("b.bin")
  })

  it("nombres que no se pueden enviar", () => {
    expect(remoteNameProblem("BOOT.BIN")).toBeNull()
    expect(remoteNameProblem("imagen ñ (1).ub")).toBeNull()
    expect(remoteNameProblem("a\nb")).toMatch(/caracteres/)
    expect(remoteNameProblem("..")).toMatch(/no válido/)
  })
})
