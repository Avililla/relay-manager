import { describe, expect, it } from "vitest"
import { openSecret, sealSecret, SSH_SECRET_INFO } from "./secret"

describe("switch password at rest", () => {
  it("round trip; another secret or a tampered value cannot open it; no plain text inside", () => {
    const s = sealSecret("admin", "secret-A-0123456789")
    expect(s).toMatch(/^v1:/)
    expect(s).not.toContain("admin")
    expect(openSecret(s, "secret-A-0123456789")).toBe("admin")
    expect(openSecret(s, "secret-B-0123456789")).toBeNull()
    expect(openSecret(`${s.slice(0, -2)}AA`, "secret-A-0123456789")).toBeNull()
    expect(openSecret("admin", "secret-A-0123456789")).toBeNull()
    expect(sealSecret("admin", "k")).not.toBe(sealSecret("admin", "k"))
  })
})

describe("equipment SSH password at rest («Enviar a equipo»)", () => {
  it("has its own key: a switch value cannot be opened as an SSH one and vice versa", () => {
    const ssh = sealSecret("root", "secret-A-0123456789", SSH_SECRET_INFO)
    expect(openSecret(ssh, "secret-A-0123456789", SSH_SECRET_INFO)).toBe("root")
    expect(openSecret(ssh, "secret-A-0123456789")).toBeNull()
    expect(openSecret(sealSecret("root", "secret-A-0123456789"), "secret-A-0123456789", SSH_SECRET_INFO)).toBeNull()
  })
})
