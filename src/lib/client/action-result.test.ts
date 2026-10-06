import { describe, expect, it } from "vitest"
import type { ActionResult } from "@/lib/contracts/common"
import { errorMessage } from "@/lib/i18n/errors"
import { interpretActionResult, loginRedirect, networkFailure } from "./action-result"

describe("interpretActionResult", () => {
  it("ok → data", () => {
    const r: ActionResult<{ id: string }> = { ok: true, data: { id: "a1" } }
    expect(interpretActionResult(r, "/equipos/a1")).toEqual({ kind: "ok", data: { id: "a1" } })
  })

  it("UNAUTHENTICATED → /login with a safe ?next=", () => {
    const r: ActionResult<null> = { ok: false, error: { code: "UNAUTHENTICATED", message: "x" } }
    expect(interpretActionResult(r, "/equipos/a1/ajustes?tab=2")).toEqual({
      kind: "redirect", to: "/login?next=%2Fequipos%2Fa1%2Fajustes%3Ftab%3D2",
    })
    expect(interpretActionResult(r, "/")).toEqual({ kind: "redirect", to: "/login" })
    // An unsafe current path collapses to "/".
    expect(interpretActionResult(r, "//evil.com")).toEqual({ kind: "redirect", to: "/login" })
    expect(loginRedirect("/api/x")).toBe("/login")
  })

  it("PASSWORD_CHANGE_REQUIRED → /cuenta?cambiar=1", () => {
    const r: ActionResult<null> = { ok: false, error: { code: "PASSWORD_CHANGE_REQUIRED", message: "x" } }
    expect(interpretActionResult(r, "/usuarios")).toEqual({ kind: "redirect", to: "/cuenta?cambiar=1" })
  })

  it("errors with fieldErrors are returned for inline display (no toast)", () => {
    const fieldErrors = { "consoles.2.key": ["Clave repetida: UART0"], _form: ["Revisa los campos"] }
    const r: ActionResult<null> = { ok: false, error: { code: "VALIDATION", message: "Revisa los campos marcados.", fieldErrors } }
    expect(interpretActionResult(r, "/equipos/nuevo")).toEqual({ kind: "field-errors", fieldErrors, message: "Revisa los campos marcados." })
  })

  it("an empty fieldErrors object is treated as a plain error", () => {
    const r: ActionResult<null> = { ok: false, error: { code: "CONFLICT", message: "", fieldErrors: {} } }
    expect(interpretActionResult(r, "/")).toEqual({ kind: "toast", message: errorMessage("CONFLICT") })
  })

  it("errors without fieldErrors → toast with the server message, else the i18n default", () => {
    const withMsg: ActionResult<null> = { ok: false, error: { code: "INTERNAL", message: "Error interno (ref 0a1b2c3d)" } }
    expect(interpretActionResult(withMsg, "/")).toEqual({ kind: "toast", message: "Error interno (ref 0a1b2c3d)" })
    const noMsg: ActionResult<null> = { ok: false, error: { code: "RESERVED_BY_OTHER", message: " ", details: { holderName: "Luis" } } }
    expect(interpretActionResult(noMsg, "/")).toEqual({ kind: "toast", message: errorMessage("RESERVED_BY_OTHER", { holderName: "Luis" }) })
  })

  it("a thrown action (network or server down) becomes an INTERNAL failure with a Spanish message", () => {
    const f = networkFailure()
    expect(f.ok).toBe(false)
    expect(f.error.code).toBe("INTERNAL")
    expect(f.error.message).toMatch(/servidor/)
  })
})
