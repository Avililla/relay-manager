import type * as React from "react"

type PendingInput = {
  onClick?: React.MouseEventHandler<HTMLButtonElement>
  "aria-disabled"?: React.AriaAttributes["aria-disabled"]
  "aria-busy"?: React.AriaAttributes["aria-busy"]
}

/**
 * Props for a button whose action is running (`<Button pending>`). A real `disabled` would blur the focused button
 * and drop focus to <body>, so the next Tab starts over at "Saltar al contenido". `aria-disabled` keeps it focused
 * and announced as unavailable, `aria-busy` says why, and clicks (and Enter/Space) are ignored until the action
 * settles, which also stops a type="submit" button from submitting. Rule-based states keep a real `disabled`.
 */
export function pendingButtonProps(pending: boolean, p: PendingInput): PendingInput {
  // Only the keys that are set: with `asChild`, an explicit `undefined` would override the child's own handler.
  if (!pending) return Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)) as PendingInput
  return {
    "aria-disabled": true,
    "aria-busy": true,
    onClick: (e) => e.preventDefault(),
  }
}

/**
 * `onCloseAutoFocus` for a dialog opened without a Radix trigger (controlled `open`, e.g. from a menu item): Radix
 * only restores focus to its trigger, so focus would fall to <body>. Puts it on `returnFocus()` instead when that
 * element is still in the document. A caller's own handler runs first and wins if it prevents the default.
 */
export function returnFocusOnClose(returnFocus: (() => HTMLElement | null) | undefined, own?: (e: Event) => void): (e: Event) => void {
  return (e) => {
    own?.(e)
    if (e.defaultPrevented || !returnFocus) return
    const el = returnFocus()
    if (!el?.isConnected) return
    e.preventDefault()
    el.focus()
  }
}
