import { describe, expect, it } from "vitest"
import { loginErrorKind } from "./login-result"

describe("loginErrorKind", () => {
  it("is null on success", () => {
    expect(loginErrorKind({ ok: true, error: undefined, code: undefined })).toBeNull()
    expect(loginErrorKind({ ok: true, error: null })).toBeNull()
  })
  it("maps the custom credential errors", () => {
    expect(loginErrorKind({ ok: false, error: "CredentialsSignin", code: "rate_limited" })).toBe("rate_limited")
    expect(loginErrorKind({ ok: false, error: "CredentialsSignin", code: "disabled" })).toBe("disabled")
  })
  it("treats every other failure as bad credentials", () => {
    expect(loginErrorKind({ ok: false, error: "CredentialsSignin", code: "credentials" })).toBe("credentials")
    expect(loginErrorKind({ ok: false, error: "Configuration" })).toBe("credentials")
    expect(loginErrorKind(undefined)).toBe("credentials")
    expect(loginErrorKind(null)).toBe("credentials")
  })
})
