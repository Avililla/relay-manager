import { describe, expect, it } from "vitest"
import { wizardKeyIntent, type WizardKeyEvent } from "./keyboard"

function ev(p: Partial<Omit<WizardKeyEvent, "target">> & { target?: Partial<WizardKeyEvent["target"]> } = {}): WizardKeyEvent {
  return {
    key: "Enter", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, isComposing: false, ...p,
    target: { tagName: "INPUT", type: "text", role: null, inPopup: false, ...p.target },
  }
}

describe("wizardKeyIntent", () => {
  it("advances on Enter in a plain text input", () => {
    expect(wizardKeyIntent(ev())).toBe("advance")
    expect(wizardKeyIntent(ev({ target: { type: "" } }))).toBe("advance")
    expect(wizardKeyIntent(ev({ target: { type: "search" } }))).toBe("advance")
  })

  it("ignores other keys", () => {
    expect(wizardKeyIntent(ev({ key: "a" }))).toBeNull()
    expect(wizardKeyIntent(ev({ key: "Tab" }))).toBeNull()
  })

  it("never advances during IME composition", () => {
    expect(wizardKeyIntent(ev({ isComposing: true }))).toBeNull()
    expect(wizardKeyIntent(ev({ keyCode: 229 }))).toBeNull()
    expect(wizardKeyIntent(ev({ isComposing: true, ctrlKey: true }))).toBeNull()
  })

  it("ignores Enter inside a listbox, combobox or popover", () => {
    expect(wizardKeyIntent(ev({ target: { inPopup: true } }))).toBeNull()
    expect(wizardKeyIntent(ev({ target: { role: "combobox" } }))).toBeNull()
    expect(wizardKeyIntent(ev({ target: { tagName: "DIV", role: "listbox" } }))).toBeNull()
  })

  it("ignores Enter on buttons, textareas, checkboxes and selects", () => {
    expect(wizardKeyIntent(ev({ target: { tagName: "BUTTON", type: "button" } }))).toBeNull()
    expect(wizardKeyIntent(ev({ target: { tagName: "TEXTAREA", type: null } }))).toBeNull()
    expect(wizardKeyIntent(ev({ target: { type: "checkbox" } }))).toBeNull()
    expect(wizardKeyIntent(ev({ target: { tagName: "SELECT" } }))).toBeNull()
  })

  it("ignores Shift+Enter and Alt+Enter", () => {
    expect(wizardKeyIntent(ev({ shiftKey: true }))).toBeNull()
    expect(wizardKeyIntent(ev({ altKey: true }))).toBeNull()
  })

  it("advances on Ctrl+Enter or Cmd+Enter from anywhere, popups included", () => {
    expect(wizardKeyIntent(ev({ ctrlKey: true, target: { tagName: "TEXTAREA" } }))).toBe("advance")
    expect(wizardKeyIntent(ev({ metaKey: true, target: { tagName: "BUTTON" } }))).toBe("advance")
    expect(wizardKeyIntent(ev({ ctrlKey: true, target: { inPopup: true, role: "listbox" } }))).toBe("advance")
  })

  it("advances on Ctrl+Enter with nothing focused (the page body) but not on a plain Enter there", () => {
    expect(wizardKeyIntent(ev({ ctrlKey: true, target: { tagName: "BODY", type: null } }))).toBe("advance")
    expect(wizardKeyIntent(ev({ target: { tagName: "BODY", type: null } }))).toBeNull()
    expect(wizardKeyIntent(ev({ ctrlKey: true, target: { tagName: "BUTTON", type: "button", role: "radio" } }))).toBe("advance")
  })
})
