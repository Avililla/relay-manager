import { describe, expect, it } from "vitest"
import { cn } from "./cn"

describe("cn knows the type scale", () => {
  it("keeps a token font size next to a text colour", () => {
    expect(cn("text-meta", "text-muted-foreground")).toBe("text-meta text-muted-foreground")
    expect(cn("text-body text-brand")).toBe("text-body text-brand")
  })
  it("still resolves conflicts inside each group", () => {
    expect(cn("text-body", "text-meta")).toBe("text-meta")
    expect(cn("text-foreground", "text-danger")).toBe("text-danger")
    expect(cn("shadow-overlay", "shadow-none")).toBe("shadow-none")
  })
})
