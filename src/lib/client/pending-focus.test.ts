import { describe, expect, it, vi } from "vitest"
import { pendingButtonProps, returnFocusOnClose } from "./pending-focus"

const click = () => {
  const e = { preventDefault: vi.fn() }
  return { e, event: e as unknown as React.MouseEvent<HTMLButtonElement> }
}

describe("pendingButtonProps (Button `pending`)", () => {
  it("keeps a running button focusable: aria-disabled + aria-busy, never `disabled`", () => {
    const props = pendingButtonProps(true, { onClick: () => {} })
    expect(props["aria-disabled"]).toBe(true)
    expect(props["aria-busy"]).toBe(true)
    expect("disabled" in props).toBe(false)
  })

  it("ignores clicks (and submits) while pending", () => {
    const run = vi.fn()
    const { e, event } = click()
    pendingButtonProps(true, { onClick: run }).onClick?.(event)
    expect(run).not.toHaveBeenCalled()
    expect(e.preventDefault).toHaveBeenCalled()
  })

  it("passes the caller's handler and aria state through when idle", () => {
    const run = vi.fn()
    const { e, event } = click()
    const props = pendingButtonProps(false, { onClick: run, "aria-busy": undefined, "aria-disabled": true })
    props.onClick?.(event)
    expect(run).toHaveBeenCalledOnce()
    expect(e.preventDefault).not.toHaveBeenCalled()
    expect(props["aria-disabled"]).toBe(true)
    expect(props["aria-busy"]).toBeUndefined()
    expect(Object.keys(pendingButtonProps(false, { onClick: undefined }))).toEqual([]) // asChild: never clobber the child's props
  })
})

describe("returnFocusOnClose (Dialog/AlertDialog `returnFocus`)", () => {
  const ev = () => ({ preventDefault: vi.fn(), defaultPrevented: false })
  it("focuses the connected target and stops Radix's own restoration", () => {
    const el = { isConnected: true, focus: vi.fn() }
    const e = ev()
    returnFocusOnClose(() => el as unknown as HTMLElement)(e as unknown as Event)
    expect(el.focus).toHaveBeenCalled()
    expect(e.preventDefault).toHaveBeenCalled()
  })
  it("leaves Radix alone without a target, or when it is gone", () => {
    const e = ev()
    returnFocusOnClose(() => null)(e as unknown as Event)
    returnFocusOnClose(() => ({ isConnected: false, focus: vi.fn() }) as unknown as HTMLElement)(e as unknown as Event)
    returnFocusOnClose(undefined)(e as unknown as Event)
    expect(e.preventDefault).not.toHaveBeenCalled()
  })
  it("runs the caller's onCloseAutoFocus first and respects its preventDefault", () => {
    const el = { isConnected: true, focus: vi.fn() }
    const e = { preventDefault: vi.fn(), defaultPrevented: true }
    const own = vi.fn()
    returnFocusOnClose(() => el as unknown as HTMLElement, own)(e as unknown as Event)
    expect(own).toHaveBeenCalled()
    expect(el.focus).not.toHaveBeenCalled()
  })
})
