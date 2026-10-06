/**
 * Keyboard focus that must not fall to <body> (§8.12, WCAG 2.4.3) in the wizard and Ajustes:
 * - a row control that removes itself ("Quitar el puerto de X", "Desvincular X", "Deshacer…") hands focus to the
 *   control that replaces it in the same row;
 * - a dialog opened without a DialogTrigger (controlled `open`) gets no focus back from Radix, which only restores
 *   focus to its trigger: `PortChoiceDialog` handles this itself, and ConfirmDialog takes `returnFocus` (W1-E).
 * Targets are found by selector at the time of the move, because the element that should get focus often only
 * exists after React has committed the change.
 */

/** A `[data-x="value"]` selector with the value escaped. */
export function dataSelector(attribute: string, value: string): string {
  return `[${attribute}="${CSS.escape(value)}"]`
}

/** The first selector that matches a connected, enabled element. */
function firstFocusable(selectors: readonly string[]): HTMLElement | null {
  for (const s of selectors) {
    const el = document.querySelector<HTMLElement>(s)
    if (el && el.isConnected && !el.matches(":disabled")) return el
  }
  return null
}

/** After the current update has been committed, focuses the first target that exists (in order of preference). */
export function focusNextFrame(...selectors: string[]): void {
  requestAnimationFrame(() => firstFocusable(selectors)?.focus())
}
