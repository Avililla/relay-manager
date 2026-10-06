// Keyboard focus helpers for the W2-C screens (WCAG 2.4.3, §8.12). A running action uses `<Button pending>` and a
// dialog without a trigger uses `returnFocus` on DialogContent / AlertDialogContent / ConfirmDialog (W1-E).
/** The element to refocus after a dialog opened from a button or from a row menu item (then: the menu's trigger). */
export function focusReturnTarget(): HTMLElement | null {
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const menu = active?.closest<HTMLElement>("[role=menu]")
  if (menu?.id) return document.querySelector<HTMLElement>(`[aria-controls="${CSS.escape(menu.id)}"]`) ?? active
  return active
}

function focusLost(): boolean {
  return document.activeElement === null || document.activeElement === document.body
}

/**
 * Focuses the first visible element `find()` returns once focus has fallen to <body>, polling for `ms`. Used when
 * the control the user acted on is replaced by a server refresh (e.g. "Actualizar IP" becomes "Ver").
 */
export function focusWhenLost(find: () => HTMLElement | null, ms = 5000): void {
  const until = performance.now() + ms
  const tick = () => {
    const el = focusLost() && !document.querySelector("[role=dialog],[role=alertdialog]") ? find() : null
    if (el) {
      el.focus()
      return
    }
    if (performance.now() < until) requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

/** The first rendered (not display:none) element matching `selector`: tables and card lists both exist in the DOM. */
export function firstVisible(selector: string): HTMLElement | null {
  for (const el of document.querySelectorAll<HTMLElement>(selector)) if (el.getClientRects().length) return el
  return null
}
