// Wizard keyboard rules (§8.9): Enter advances only from a plain text input outside any listbox/combobox and never
// during IME composition; Ctrl+Enter (Cmd+Enter on macOS) advances from anywhere. Pure; the component adapts the DOM.

const TEXT_TYPES = new Set(["", "text", "search", "email", "number", "tel", "url", "password"])

export interface WizardKeyEvent {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
  isComposing: boolean
  /** 229 while an IME is composing in some browsers that do not set isComposing. */
  keyCode?: number
  target: {
    tagName: string
    type?: string | null
    role?: string | null
    /** Inside a listbox, combobox, menu, dialog or popover (the component checks with `closest`). */
    inPopup: boolean
  }
}

export function wizardKeyIntent(e: WizardKeyEvent): "advance" | null {
  if (e.key !== "Enter") return null
  if (e.isComposing || e.keyCode === 229) return null
  if (e.altKey) return null
  if (e.ctrlKey || e.metaKey) return "advance"
  if (e.shiftKey) return null
  const t = e.target
  if (t.inPopup) return null
  if (t.role === "combobox" || t.role === "listbox" || t.role === "option") return null
  if (t.tagName.toUpperCase() !== "INPUT") return null
  return TEXT_TYPES.has((t.type ?? "").toLowerCase()) ? "advance" : null
}

/** CSS selector for the containers where Enter belongs to the widget, not to the wizard. */
export const POPUP_SELECTOR = [
  "[role=listbox]", "[role=combobox]", "[role=menu]", "[role=dialog]", "[role=alertdialog]",
  "[data-radix-popper-content-wrapper]", "[cmdk-root]",
].join(",")
