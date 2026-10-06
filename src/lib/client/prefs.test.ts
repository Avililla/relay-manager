import { describe, expect, it } from "vitest"
import {
  PANES_STORAGE_PREFIX, TERM_FONT, TERM_SCROLLBACK, layoutKey, panesKey, parsePref, parsePrefKey, readPref, serializePref,
  writePref, panesStorage, type PrefStorage,
} from "./prefs"

describe("prefs keys", () => {
  it("parses the fixed and per-equipment keys", () => {
    expect(parsePrefKey("rm-theme")).toEqual({ kind: "theme" })
    expect(parsePrefKey("rm-term-font")).toEqual({ kind: "term-font" })
    expect(parsePrefKey("rm-term-scrollback")).toEqual({ kind: "term-scrollback" })
    expect(parsePrefKey("rm-term-sr")).toEqual({ kind: "term-sr" })
    expect(parsePrefKey("rm-banco-view")).toEqual({ kind: "banco-view" })
    expect(parsePrefKey("rm-layout:cmf1abc")).toEqual({ kind: "layout", equipmentId: "cmf1abc" })
    expect(parsePrefKey("rm-panes:cmf1abc:grid:4")).toEqual({ kind: "panes", equipmentId: "cmf1abc", layout: "grid", count: 4 })
  })

  it("rejects unknown or malformed keys", () => {
    for (const k of ["rm-other", "theme", "rm-layout:", "rm-layout:a:b", "rm-layout:ab-cd", "rm-panes:a:grid", "rm-panes:a:diagonal:2",
      "rm-panes:a:grid:0", "rm-panes:a:grid:17", "rm-panes:a:grid:x"]) {
      expect(parsePrefKey(k), k).toBeNull()
    }
  })

  it("builds keys", () => {
    expect(layoutKey("e1")).toBe("rm-layout:e1")
    expect(panesKey("e1", "columns", 3)).toBe("rm-panes:e1:columns:3")
  })
})

describe("prefs values and ranges", () => {
  it("theme: invalid → dark", () => {
    expect(parsePref("rm-theme", null)).toBe("dark")
    expect(parsePref("rm-theme", "sepia")).toBe("dark")
    expect(parsePref("rm-theme", "system")).toBe("system")
  })

  it("terminal font 11–16 (default 13), integers only", () => {
    expect(TERM_FONT).toEqual({ min: 11, max: 16, default: 13 })
    expect(parsePref("rm-term-font", null)).toBe(13)
    expect(parsePref("rm-term-font", "15")).toBe(15)
    expect(parsePref("rm-term-font", "9")).toBe(11)
    expect(parsePref("rm-term-font", "40")).toBe(16)
    expect(parsePref("rm-term-font", "13.5")).toBe(13)
    expect(parsePref("rm-term-font", "abc")).toBe(13)
  })

  it("scrollback 1000–50000 (default 10000)", () => {
    expect(TERM_SCROLLBACK).toEqual({ min: 1000, max: 50000, default: 10000 })
    expect(parsePref("rm-term-scrollback", null)).toBe(10000)
    expect(parsePref("rm-term-scrollback", "20000")).toBe(20000)
    expect(parsePref("rm-term-scrollback", "10")).toBe(1000)
    expect(parsePref("rm-term-scrollback", "999999")).toBe(50000)
    expect(parsePref("rm-term-scrollback", "")).toBe(10000)
  })

  it("screen-reader mode is off unless explicitly on", () => {
    expect(parsePref("rm-term-sr", null)).toBe(false)
    expect(parsePref("rm-term-sr", "1")).toBe(true)
    expect(parsePref("rm-term-sr", "true")).toBe(false)
    expect(serializePref("rm-term-sr", true)).toBe("1")
    expect(serializePref("rm-term-sr", false)).toBe("0")
  })

  it("layout is columns, grid or tabs, else null (the workspace picks a default)", () => {
    expect(parsePref("rm-layout:e1", "grid")).toBe("grid")
    expect(parsePref("rm-layout:e1", "tabs")).toBe("tabs")
    expect(parsePref("rm-layout:e1", "mosaic")).toBeNull()
    expect(parsePref("rm-layout:e1", null)).toBeNull()
  })

  it("files archive format is zip or tar.gz per user, else null", () => {
    expect(parsePrefKey("rm-files-archive:u1")).toEqual({ kind: "files-archive", userId: "u1" })
    expect(parsePrefKey("rm-files-archive:../x")).toBeNull()
    expect(parsePref("rm-files-archive:u1", "tar.gz")).toBe("tar.gz")
    expect(parsePref("rm-files-archive:u1", "zip")).toBe("zip")
    expect(parsePref("rm-files-archive:u1", "rar")).toBeNull()
    expect(parsePref("rm-files-archive:u1", null)).toBeNull()
  })

  it("banco view is grid or list (default grid)", () => {
    expect(parsePref("rm-banco-view", null)).toBe("grid")
    expect(parsePref("rm-banco-view", "list")).toBe("list")
    expect(parsePref("rm-banco-view", "table")).toBe("grid")
  })

  it("serialises numbers as integers within range", () => {
    expect(serializePref("rm-term-font", 20)).toBe("16")
    expect(serializePref("rm-term-scrollback", 12345.6)).toBe("12346")
  })
})

function memoryStorage(fail = false): PrefStorage & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (k) => { if (fail) throw new Error("SecurityError"); return data.get(k) ?? null },
    setItem: (k, v) => { if (fail) throw new Error("QuotaExceededError"); data.set(k, v) },
    removeItem: (k) => { if (fail) throw new Error("SecurityError"); data.delete(k) },
  }
}

describe("storage access never throws", () => {
  it("reads and writes through the storage", () => {
    const s = memoryStorage()
    expect(writePref("rm-term-font", 15, s)).toBe(true)
    expect(s.data.get("rm-term-font")).toBe("15")
    expect(readPref("rm-term-font", s)).toBe(15)
  })

  it("falls back to defaults when storage throws or is missing", () => {
    const s = memoryStorage(true)
    expect(readPref("rm-term-font", s)).toBe(13)
    expect(writePref("rm-term-font", 15, s)).toBe(false)
    expect(readPref("rm-theme", null)).toBe("dark")
    expect(writePref("rm-theme", "light", null)).toBe(false)
  })

  it("panesStorage maps react-resizable-panels keys onto rm-panes:* only", () => {
    const s = memoryStorage()
    const ps = panesStorage(s)
    ps.setItem(`${PANES_STORAGE_PREFIX}rm-panes:e1:columns:2`, "{\"a\":1}")
    expect(s.data.get("rm-panes:e1:columns:2")).toBe("{\"a\":1}")
    expect(ps.getItem(`${PANES_STORAGE_PREFIX}rm-panes:e1:columns:2`)).toBe("{\"a\":1}")
    // Anything that is not an rm-panes key is dropped.
    ps.setItem(`${PANES_STORAGE_PREFIX}other`, "x")
    expect([...s.data.keys()]).toEqual(["rm-panes:e1:columns:2"])
    expect(ps.getItem(`${PANES_STORAGE_PREFIX}other`)).toBeNull()
    const failing = panesStorage(memoryStorage(true))
    expect(() => failing.setItem(`${PANES_STORAGE_PREFIX}rm-panes:e1:grid:4`, "x")).not.toThrow()
    expect(failing.getItem(`${PANES_STORAGE_PREFIX}rm-panes:e1:grid:4`)).toBeNull()
  })
})
