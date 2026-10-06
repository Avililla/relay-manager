import { describe, expect, it } from "vitest"
import { UPLOAD_TEMP_PREFIX } from "@/lib/contracts/files"
import { baseName, joinRel, keepBothName, nextFreeName, parentRel, parseRelPath, validateNewName } from "./names"

describe("parseRelPath", () => {
  it("accepts the root and plain relative paths", () => {
    expect(parseRelPath("")).toEqual({ ok: true, segments: [], path: "" })
    expect(parseRelPath("a")).toEqual({ ok: true, segments: ["a"], path: "a" })
    expect(parseRelPath("imágenes/boot.bin")).toEqual({ ok: true, segments: ["imágenes", "boot.bin"], path: "imágenes/boot.bin" })
    // Odd but legal names stay inside the folder: they are single segments.
    expect(parseRelPath("%2e%2e/x").ok).toBe(true)
    expect(parseRelPath("...").ok).toBe(true)
    expect(parseRelPath("a b/c").ok).toBe(true)
  })

  it.each([
    ["..", "parent"],
    ["../etc/passwd", "parent at the start"],
    ["a/../../b", "parent in the middle"],
    ["a/..", "parent at the end"],
    [".", "dot"],
    ["a/./b", "dot segment"],
    ["/etc/passwd", "absolute"],
    ["/", "slash"],
    ["a//b", "empty segment"],
    ["a/", "trailing slash"],
    ["a\0b", "NUL"],
    ["x".repeat(256), "segment over 255 bytes"],
    ["ñ".repeat(128), "segment over 255 bytes (UTF-8)"],
    ["a/".repeat(2100) + "b", "too long"],
  ])("rejects %j (%s)", (raw) => {
    expect(parseRelPath(raw).ok).toBe(false)
  })

  it("rejects non strings", () => {
    expect(parseRelPath(undefined).ok).toBe(false)
    expect(parseRelPath(3).ok).toBe(false)
    expect(parseRelPath(["a"]).ok).toBe(false)
  })
})

describe("validateNewName", () => {
  it("accepts ordinary names", () => {
    for (const n of ["BOOT.BIN", "imagen v2.ub", "informe (1).pdf", ".config", "a", "ñandú.tar.gz", "x".repeat(255)]) {
      expect(validateNewName(n)).toBeNull()
    }
  })

  it.each([
    ["", "vacío"],
    [".", "punto"],
    ["..", "dos puntos"],
    ["a/b", "barra"],
    ["a\\b", "barra invertida"],
    ["a\nb", "salto de línea"],
    ["a\u0007b", "control"],
    ["a\u007fb", "DEL"],
    ["a\0b", "NUL"],
    [" a", "espacio inicial"],
    ["a ", "espacio final"],
    ["x".repeat(256), "largo"],
    ["ñ".repeat(128), "largo en UTF-8"],
    [`${UPLOAD_TEMP_PREFIX}abc.part`, "reservado"],
  ])("rejects %j (%s) with a Spanish message", (name) => {
    const msg = validateNewName(name)
    expect(msg).toBeTypeOf("string")
    expect(msg).toMatch(/nombre|Escribe/)
  })
})

describe("keepBothName / nextFreeName", () => {
  it("numbers before the extension, like browsers do", () => {
    expect(keepBothName("informe.pdf", 1)).toBe("informe (1).pdf")
    expect(keepBothName("informe.pdf", 2)).toBe("informe (2).pdf")
    expect(keepBothName("BOOT", 1)).toBe("BOOT (1)")
    expect(keepBothName(".bashrc", 1)).toBe(".bashrc (1)")
    expect(keepBothName("rootfs.tar.gz", 1)).toBe("rootfs (1).tar.gz")
    expect(keepBothName("informe (1).pdf", 2)).toBe("informe (2).pdf")
  })

  it("keeps the result within 255 bytes", () => {
    const long = `${"ñ".repeat(125)}.bin`
    const r = keepBothName(long, 12)
    expect(Buffer.byteLength(r)).toBeLessThanOrEqual(255)
    expect(r.endsWith(" (12).bin")).toBe(true)
    expect(validateNewName(r)).toBeNull()
  })

  it("finds the first free name", () => {
    const taken = new Set(["a.txt", "a (1).txt", "a (2).txt"])
    expect(nextFreeName("a.txt", (n) => taken.has(n))).toBe("a (3).txt")
    expect(nextFreeName("b.txt", (n) => taken.has(n))).toBe("b.txt")
  })
})

describe("joinRel / parentRel / baseName", () => {
  it("builds and splits relative paths", () => {
    expect(joinRel("", "a")).toBe("a")
    expect(joinRel("a/b", "c")).toBe("a/b/c")
    expect(parentRel("a/b/c")).toBe("a/b")
    expect(parentRel("a")).toBe("")
    expect(parentRel("")).toBe("")
    expect(baseName("a/b/c.txt")).toBe("c.txt")
    expect(baseName("")).toBe("")
  })
})
