import { describe, expect, it } from "vitest"
import { checkExportForm, defaultZipName } from "./export-form"

const form = (over = {}) => ({ app: "app_demo", version: "1.4.2", extract: false, zipName: "", dir: "", ...over })

describe("checkExportForm", () => {
  it("builds the request (trimmed, default zip name left to the server, .zip added)", () => {
    expect(checkExportForm(form())).toEqual({ ok: true, input: { app: "app_demo", version: "1.4.2", extract: false, zipName: null, dir: "" } })
    expect(checkExportForm(form({ zipName: " entrega ", dir: "/apps/demo/", extract: true }))).toEqual({
      ok: true, input: { app: "app_demo", version: "1.4.2", extract: true, zipName: "entrega.zip", dir: "apps/demo" },
    })
    expect(defaultZipName("a", "1")).toBe("a-1_exports.zip")
  })

  it("refuses names outside the Conan charset, options and hidden or traversal paths", () => {
    const bad = checkExportForm(form({ app: "-x", version: "1.0; rm -rf /", zipName: ".oculto", dir: "../etc" }))
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(Object.keys(bad.errors).sort()).toEqual(["app", "dir", "version", "zipName"])
    const work = checkExportForm(form({ dir: ".descargas/x" }))
    expect(work.ok).toBe(false)
    expect(checkExportForm(form({ app: "" })).ok).toBe(false)
    expect(checkExportForm(form({ app: "a".repeat(101) })).ok).toBe(false)
  })
})
