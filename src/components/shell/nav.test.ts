import { describe, expect, it } from "vitest"
import { activeNavItem, navGroupsFor } from "./nav"

describe("navigation", () => {
  it("everyone sees Banco and Archivos; administrators see the rest", () => {
    const hrefs = (isAdmin: boolean, filesEnabled?: boolean) => navGroupsFor(isAdmin, { filesEnabled }).flatMap((g) => g.items.map((i) => i.href))
    expect(hrefs(false)).toEqual(["/", "/archivos"])
    expect(hrefs(true)).toContain("/archivos")
    expect(hrefs(true)).toContain("/sistema")
    // RM_FILES_ENABLED=0 removes the entry.
    expect(hrefs(false, false)).toEqual(["/"])
    expect(hrefs(true, false)).not.toContain("/archivos")
  })

  it("marks Archivos as the active item on its pages", () => {
    expect(activeNavItem("/archivos")?.href).toBe("/archivos")
    expect(activeNavItem("/")?.href).toBe("/")
    expect(activeNavItem("/equipos/x")?.href).toBe("/")
  })
})
