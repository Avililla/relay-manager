import { describe, expect, it } from "vitest"
import { defaultLayout, effectiveLayout, gridColumns, gridRows, parseShortcut, sameIds } from "./layout-model"

describe("layouts (§8.9)", () => {
  it("default: columns up to 3 consoles, grid from 4", () => {
    expect([1, 2, 3, 4, 7].map(defaultLayout)).toEqual(["columns", "columns", "columns", "grid", "grid"])
  })
  it("the stored preference wins, except below 768 px where tabs are forced", () => {
    expect(effectiveLayout(null, 2, false)).toBe("columns")
    expect(effectiveLayout("grid", 2, false)).toBe("grid")
    expect(effectiveLayout("columns", 6, false)).toBe("columns")
    expect(effectiveLayout("grid", 6, true)).toBe("tabs")
    expect(effectiveLayout(null, 1, true)).toBe("tabs")
  })
  it("grid: 2 columns, 3 from 7 consoles on screens of 1600 px or more", () => {
    expect(gridColumns(4, 1440)).toBe(2)
    expect(gridColumns(7, 1440)).toBe(2)
    expect(gridColumns(7, 1600)).toBe(3)
    expect(gridColumns(6, 1920)).toBe(2)
    expect(gridColumns(1, 1920)).toBe(1)
  })
  it("grid rows fill left to right", () => {
    expect(gridRows(["a", "b", "c", "d", "e"], 2)).toEqual([["a", "b"], ["c", "d"], ["e"]])
    expect(gridRows(["a", "b", "c", "d", "e", "f", "g"], 3)).toEqual([["a", "b", "c"], ["d", "e", "f"], ["g"]])
    expect(gridRows([], 2)).toEqual([])
  })
})

describe("workspace shortcuts (§8.9)", () => {
  const k = (key: string, mods: { ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean } = {}) =>
    ({ key, ctrlKey: !!mods.ctrl, altKey: !!mods.alt, shiftKey: !!mods.shift, metaKey: !!mods.meta })
  it("Ctrl+Alt+1..9 focuses pane N", () => {
    expect(parseShortcut(k("1", { ctrl: true, alt: true }), { maximized: false, inTerminal: true })).toEqual({ kind: "focus", index: 0 })
    expect(parseShortcut(k("9", { ctrl: true, alt: true }), { maximized: false, inTerminal: false })).toEqual({ kind: "focus", index: 8 })
  })
  it("Ctrl+Alt+Enter toggles maximise", () => {
    expect(parseShortcut(k("Enter", { ctrl: true, alt: true }), { maximized: false, inTerminal: true })).toEqual({ kind: "toggle-maximize" })
  })
  it("Esc restores only when maximised and focus is outside the terminal", () => {
    expect(parseShortcut(k("Escape"), { maximized: true, inTerminal: false })).toEqual({ kind: "restore" })
    expect(parseShortcut(k("Escape"), { maximized: true, inTerminal: true })).toBeNull()
    expect(parseShortcut(k("Escape"), { maximized: false, inTerminal: false })).toBeNull()
  })
  it("ignores other chords: Alt+1 (Firefox tabs), Ctrl+1, Ctrl+Alt+0, Ctrl+Alt+Shift+1, AltGr symbols", () => {
    const ctx = { maximized: false, inTerminal: true }
    expect(parseShortcut(k("1", { alt: true }), ctx)).toBeNull()
    expect(parseShortcut(k("1", { ctrl: true }), ctx)).toBeNull()
    expect(parseShortcut(k("0", { ctrl: true, alt: true }), ctx)).toBeNull()
    expect(parseShortcut(k("1", { ctrl: true, alt: true, shift: true }), ctx)).toBeNull()
    expect(parseShortcut(k("|", { ctrl: true, alt: true }), ctx)).toBeNull()
    expect(parseShortcut(k("1", { ctrl: true, alt: true, meta: true }), ctx)).toBeNull()
  })
})

describe("sameIds", () => {
  it("compares id lists in order", () => {
    expect(sameIds(["a", "b"], ["a", "b"])).toBe(true)
    expect(sameIds(["a", "b"], ["b", "a"])).toBe(false)
    expect(sameIds(["a"], ["a", "b"])).toBe(false)
  })
})
