import { describe, expect, it } from "vitest"
import { NARROW_PANE_PX, paneToolbarLayout } from "./toolbar-layout"

describe("paneToolbarLayout (§8.9: the channel strip folds progressively, actions fold below 520 px)", () => {
  it("unmeasured (0) and wide panes show everything", () => {
    for (const w of [0, NARROW_PANE_PX, 900]) {
      expect(paneToolbarLayout(w, "open")).toEqual({ actionsInMenu: false, label: true, adapter: true, line: true, capture: true })
    }
  })
  it("below 520 px the actions move into ⋯ and the label goes first; the strip stays", () => {
    expect(paneToolbarLayout(470, "open")).toEqual({ actionsInMenu: true, label: false, adapter: true, line: true, capture: true })
  })
  it("then the adapter, then the capture badge, then the line summary", () => {
    expect(paneToolbarLayout(380, "open")).toMatchObject({ adapter: false, capture: true, line: true })
    expect(paneToolbarLayout(320, "open")).toMatchObject({ adapter: false, capture: false, line: true })
    expect(paneToolbarLayout(260, "open")).toMatchObject({ adapter: false, capture: false, line: false, actionsInMenu: true })
  })
  it("an unbound console has nothing to record: no capture badge at any width", () => {
    expect(paneToolbarLayout(900, "unbound").capture).toBe(false)
    expect(paneToolbarLayout(900, "missing").capture).toBe(true)
  })
})
