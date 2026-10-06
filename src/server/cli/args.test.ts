import { describe, expect, it } from "vitest"
import { parseArgs, UsageError } from "./args"

const SPEC = { boolean: ["yes", "admin", "json", "dry-run"], string: ["label", "name", "to"] } as const

describe("parseArgs", () => {
  it("splits positionals and flags, with --flag value and --flag=value", () => {
    expect(parseArgs(["create", "ana", "--name", "Ana López", "--admin"], SPEC)).toEqual({
      positionals: ["create", "ana"], flags: { name: "Ana López", admin: true },
    })
    expect(parseArgs(["--label=pre-upgrade-1.0.0-to-2.0.0"], SPEC)).toEqual({ positionals: [], flags: { label: "pre-upgrade-1.0.0-to-2.0.0" } })
  })

  it("-- ends the flags", () => {
    expect(parseArgs(["restore", "--", "--yes"], SPEC)).toEqual({ positionals: ["restore", "--yes"], flags: {} })
  })

  it("rejects unknown flags, a missing value, a value on a boolean flag and repeated flags", () => {
    expect(() => parseArgs(["--nope"], SPEC)).toThrow(UsageError)
    expect(() => parseArgs(["--nope"], SPEC)).toThrow("Opción desconocida: --nope")
    expect(() => parseArgs(["--label"], SPEC)).toThrow("La opción --label necesita un valor")
    expect(() => parseArgs(["--label", "--yes"], SPEC)).toThrow("La opción --label necesita un valor")
    expect(() => parseArgs(["--yes=1"], SPEC)).toThrow(UsageError)
    expect(() => parseArgs(["--label", "a", "--label", "b"], SPEC)).toThrow("La opción --label está repetida")
  })

  it("rejects short options", () => {
    expect(() => parseArgs(["-y"], SPEC)).toThrow(UsageError)
  })
})
